"""JSON export / import of the entire database."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlmodel import Session, select

from app.db import clear_all_rows, ensure_world_countries, get_session, wipe_all
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


def _dump(session: Session) -> ExportPayload:
    entities = [_entity_read(e) for e in session.exec(select(Entity)).all()]
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

    replace = options.mode == "replace"
    try:
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

    return {
        "ok": True,
        "mode": options.mode,
        "entities": len(payload.entities),
        "links": len(payload.links),
    }


@router.post("/wipe")
def wipe_db(session: Session = Depends(get_session)) -> dict:
    try:
        wipe_all(session)
    except Exception as exc:
        session.rollback()
        raise HTTPException(500, f"Reset failed; the database was not changed. {exc}") from exc
    return {"ok": True}
