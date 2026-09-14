"""JSON export / import of the entire database."""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlmodel import Session, select

from app.api.upload import MAX_BYTES, _ext_from_bytes, find_upload
from app.db import clear_all_rows, ensure_world_countries, get_session, resolve_upload_dir, wipe_all
from app.models import (
    Entity,
    EntityRead,
    ExportPayload,
    ImportOptions,
    Link,
    LinkRead,
    Progress,
    ProgressRead,
    ReviewState,
    ReviewStateRead,
)

router = APIRouter(tags=["backup"])

_UPLOAD_URL_RE = re.compile(r"(?:https?://[^/]+)?/static/uploads/([^/?#]+)(?:\?.*)?$", re.IGNORECASE)
_DATA_URL_RE = re.compile(
    r"^data:image/(png|jpeg|jpg|gif|webp);base64,(.+)$",
    re.IGNORECASE | re.DOTALL,
)
_SAFE_FILE_RE = re.compile(r"^[A-Za-z0-9._-]{1,200}$")


def _upload_filename(url: str) -> str | None:
    raw = (url or "").strip()
    match = _UPLOAD_URL_RE.search(raw)
    if not match:
        return None
    name = Path(match.group(1)).name
    if name != match.group(1):
        return None
    return name


def _entity_read(e: Entity) -> EntityRead:
    data = e.model_dump()
    if data.get("tags") is None:
        data["tags"] = []
    if data.get("attachments") is None:
        data["attachments"] = []
    if data.get("country_names") is None:
        data["country_names"] = []
    return EntityRead.model_validate(data)


def _progress_read(progress: Progress) -> ProgressRead:
    data = progress.model_dump()
    if data.get("categories") is None:
        data["categories"] = []
    validated = ProgressRead.model_validate(data)
    validated.goal_hit_today = progress.xp_today >= progress.daily_goal_xp
    return validated


def _pack_attachment(url: str, files: dict[str, str]) -> tuple[str, bool]:
    """Return (url to store, packed?). Missing local files stay as the original URL."""
    raw = (url or "").strip()
    if not raw:
        return raw, False

    data_m = _DATA_URL_RE.match(raw)
    if data_m:
        try:
            blob = base64.b64decode(data_m.group(2), validate=False)
        except (binascii.Error, ValueError):
            return raw, False
        ext = _ext_from_bytes(blob)
        if not ext:
            return raw, False
        name = f"{uuid.uuid4().hex}{ext}"
        files[name] = base64.b64encode(blob).decode("ascii")
        return f"/static/uploads/{name}", True

    name = _upload_filename(raw)
    if not name:
        return raw, False
    path = find_upload(name)
    if path is None:
        return raw, False
    if name not in files:
        files[name] = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"/static/uploads/{name}", True


def _pack_entity_media(entities: list[EntityRead]) -> tuple[list[EntityRead], dict[str, str], int]:
    files: dict[str, str] = {}
    missing = 0
    packed: list[EntityRead] = []
    for entity in entities:
        data = entity.model_dump()
        next_atts: list[str] = []
        for url in data.get("attachments") or []:
            stored, ok = _pack_attachment(url, files)
            next_atts.append(stored)
            if _upload_filename(url) and not ok:
                missing += 1
        data["attachments"] = next_atts
        packed.append(EntityRead.model_validate(data))
    return packed, files, missing


def _restore_media_files(files: dict[str, str]) -> int:
    dest = resolve_upload_dir()
    dest.mkdir(parents=True, exist_ok=True)
    restored = 0
    for name, payload in (files or {}).items():
        safe = Path(str(name)).name
        if safe != name or not _SAFE_FILE_RE.match(safe):
            raise HTTPException(400, f"Invalid backup image name: {name}")
        try:
            blob = base64.b64decode(payload, validate=False)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(400, f"Backup image {safe} is not valid base64") from exc
        if len(blob) > MAX_BYTES:
            raise HTTPException(400, f"Backup image {safe} is larger than 5 MB")
        if not blob or _ext_from_bytes(blob) is None:
            raise HTTPException(400, f"Backup image {safe} is not a valid JPEG, PNG, GIF, or WebP")
        (dest / safe).write_bytes(blob)
        restored += 1
    return restored


def _dump(session: Session) -> ExportPayload:
    entities, files, missing = _pack_entity_media(
        [_entity_read(e) for e in session.exec(select(Entity)).all()]
    )
    links = [LinkRead.model_validate(l) for l in session.exec(select(Link)).all()]
    reviews = [ReviewStateRead.model_validate(r) for r in session.exec(select(ReviewState)).all()]
    progress = session.get(Progress, 1) or Progress(id=1)
    return ExportPayload(
        version=1,
        exported_at=datetime.now(timezone.utc),
        entities=entities,
        links=links,
        review_states=reviews,
        progress=_progress_read(progress),
        files=files,
        files_missing=missing,
    )


def _validate_payload(payload: ExportPayload) -> None:
    if payload.version != 1:
        raise HTTPException(400, f"Unsupported backup version: {payload.version}")

    entity_ids = [e.id for e in payload.entities]
    if len(entity_ids) != len(set(entity_ids)):
        raise HTTPException(400, "Backup contains duplicate entity ids")
    id_set = set(entity_ids)

    link_ids = [link.id for link in payload.links]
    if len(link_ids) != len(set(link_ids)):
        raise HTTPException(400, "Backup contains duplicate link ids")

    for entity in payload.entities:
        if entity.parent_id and entity.parent_id not in id_set:
            raise HTTPException(
                400,
                f"Entity {entity.id} parent_id references missing entity {entity.parent_id}",
            )

    for link in payload.links:
        if link.source_id not in id_set or link.target_id not in id_set:
            raise HTTPException(
                400,
                f"Link {link.id} references missing entity "
                f"({link.source_id} → {link.target_id})",
            )

    review_ids = [rs.entity_id for rs in payload.review_states]
    if len(review_ids) != len(set(review_ids)):
        raise HTTPException(400, "Backup contains duplicate review states")
    for rs in payload.review_states:
        if rs.entity_id not in id_set:
            raise HTTPException(400, f"ReviewState for unknown entity {rs.entity_id}")


def _upsert_row(session: Session, model, key, data: dict) -> None:
    existing = session.get(model, key)
    if existing:
        for k, v in data.items():
            setattr(existing, k, v)
        session.add(existing)
        return
    session.add(model(**data))


def _insert_payload(session: Session, payload: ExportPayload, *, replace: bool) -> None:
    for entity in payload.entities:
        data = entity.model_dump()
        next_atts = []
        for url in data.get("attachments") or []:
            name = _upload_filename(url)
            next_atts.append(f"/static/uploads/{name}" if name else url)
        data["attachments"] = next_atts
        if replace:
            session.add(Entity(**data))
        else:
            _upsert_row(session, Entity, entity.id, data)

    session.flush()

    for link in payload.links:
        data = link.model_dump()
        if replace:
            session.add(Link(**data))
        else:
            _upsert_row(session, Link, link.id, data)

    for rs in payload.review_states:
        data = rs.model_dump()
        if replace:
            session.add(ReviewState(**data))
        else:
            _upsert_row(session, ReviewState, rs.entity_id, data)

    if payload.progress is not None:
        pdata = payload.progress.model_dump(exclude={"id", "goal_hit_today"})
        progress = session.get(Progress, 1)
        if progress is None:
            progress = Progress(id=1)
        for k, v in pdata.items():
            setattr(progress, k, v)
        session.add(progress)
    elif session.get(Progress, 1) is None:
        session.add(Progress(id=1))


@router.get("/export")
def export_db(session: Session = Depends(get_session)) -> JSONResponse:
    payload = _dump(session)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return JSONResponse(
        content=payload.model_dump(mode="json"),
        headers={
            "Content-Disposition": f'attachment; filename="historia-backup-{stamp}.json"'
        },
    )


@router.post("/import")
def import_db(options: ImportOptions, session: Session = Depends(get_session)) -> dict:
    if options.mode not in ("merge", "replace"):
        raise HTTPException(400, "mode must be 'merge' or 'replace'")

    payload = options.payload
    _validate_payload(payload)
    entities, packed_files, _missing = _pack_entity_media(payload.entities)
    payload.entities = entities
    # Prefer files already in the backup over whatever happens to be on disk.
    payload.files = {**packed_files, **(payload.files or {})}

    replace = options.mode == "replace"
    try:
        # Write images first so a bad backup cannot wipe the library.
        files_restored = _restore_media_files(payload.files or {})
        if replace:
            # Same transaction as the inserts — never commit a wipe on its own.
            clear_all_rows(session)
        _insert_payload(session, payload, replace=replace)
        ensure_world_countries(session)
        session.commit()
    except HTTPException:
        session.rollback()
        raise
    except Exception as exc:
        session.rollback()
        raise HTTPException(
            400,
            f"Import failed; the current database was not changed. {exc}",
        ) from exc

    missing = 0
    restored_names = set(payload.files or {})
    for entity in payload.entities:
        for url in entity.attachments or []:
            name = _upload_filename(url)
            if name and name not in restored_names and find_upload(name) is None:
                missing += 1

    return {
        "ok": True,
        "mode": options.mode,
        "entities": len(payload.entities),
        "links": len(payload.links),
        "files": files_restored,
        "files_missing": missing,
    }


@router.post("/wipe")
def wipe_db(session: Session = Depends(get_session)) -> dict:
    try:
        wipe_all(session)
    except Exception as exc:
        session.rollback()
        raise HTTPException(500, f"Reset failed; the database was not changed. {exc}") from exc
    return {"ok": True}
