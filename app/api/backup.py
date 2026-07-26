"""JSON export / import of the entire database."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlmodel import Session, select

from app.db import get_session, wipe_all
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


def _dump(session: Session) -> ExportPayload:
    entities = [EntityRead.model_validate(e) for e in session.exec(select(Entity)).all()]
    links = [LinkRead.model_validate(l) for l in session.exec(select(Link)).all()]
    reviews = [ReviewStateRead.model_validate(r) for r in session.exec(select(ReviewState)).all()]
    progress = session.get(Progress, 1) or Progress(id=1)
    return ExportPayload(
        version=1,
        exported_at=datetime.now(timezone.utc),
        entities=entities,
        links=links,
        review_states=reviews,
        progress=ProgressRead.model_validate(progress),
    )


@router.get("/export")
def export_db(session: Session = Depends(get_session)) -> JSONResponse:
    payload = _dump(session)
    return JSONResponse(
        content=payload.model_dump(mode="json"),
        headers={"Content-Disposition": 'attachment; filename="historia-export.json"'},
    )


@router.post("/import")
def import_db(options: ImportOptions, session: Session = Depends(get_session)) -> dict:
    if options.mode not in ("merge", "replace"):
        raise HTTPException(400, "mode must be 'merge' or 'replace'")

    payload = options.payload
    if payload.version != 1:
        raise HTTPException(400, f"Unsupported export version: {payload.version}")

    # Validate referential integrity before writing
    entity_ids = {e.id for e in payload.entities}
    for link in payload.links:
        if link.source_id not in entity_ids or link.target_id not in entity_ids:
            raise HTTPException(
                400,
                f"Link {link.id} references missing entity "
                f"({link.source_id} → {link.target_id})",
            )
    for rs in payload.review_states:
        if rs.entity_id not in entity_ids:
            raise HTTPException(400, f"ReviewState for unknown entity {rs.entity_id}")

    if options.mode == "replace":
        wipe_all(session)

    # Upsert entities
    for e in payload.entities:
        existing = session.get(Entity, e.id)
        data = e.model_dump()
        if existing:
            for k, v in data.items():
                setattr(existing, k, v)
            session.add(existing)
        else:
            session.add(Entity(**data))

    session.flush()

    for link in payload.links:
        existing = session.get(Link, link.id)
        data = link.model_dump()
        if existing:
            for k, v in data.items():
                setattr(existing, k, v)
            session.add(existing)
        else:
            session.add(Link(**data))

    for rs in payload.review_states:
        existing = session.get(ReviewState, rs.entity_id)
        data = rs.model_dump()
        if existing:
            for k, v in data.items():
                setattr(existing, k, v)
            session.add(existing)
        else:
            session.add(ReviewState(**data))

    # Progress: replace fields on the singleton row
    progress = session.get(Progress, 1)
    if progress is None:
        progress = Progress(id=1)
    pdata = payload.progress.model_dump(exclude={"id", "goal_hit_today"})
    for k, v in pdata.items():
        setattr(progress, k, v)
    session.add(progress)

    session.commit()
    return {
        "ok": True,
        "mode": options.mode,
        "entities": len(payload.entities),
        "links": len(payload.links),
    }


@router.post("/wipe")
def wipe_db(session: Session = Depends(get_session)) -> dict:
    wipe_all(session)
    return {"ok": True}
