"""Topic grouping endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.db import get_session
from app.models import (
    Entity,
    EntityRead,
    EntityType,
    Link,
    RelationType,
    ReviewState,
    TopicCreate,
    utcnow,
)

router = APIRouter(prefix="/topics", tags=["topics"])

_EVENT_LIKE = {EntityType.event, EntityType.milestone}


def _topic_summary(n_events: int, n_phases: int, custom: str | None) -> str:
    if custom and custom.strip():
        return custom.strip()
    parts: list[str] = []
    if n_events:
        parts.append(f"{n_events} event{'s' if n_events != 1 else ''}")
    if n_phases:
        parts.append(f"{n_phases} phase{'s' if n_phases != 1 else ''}")
    return " · ".join(parts) if parts else "Empty topic — add events or phases"


@router.post("", response_model=EntityRead, status_code=201)
def create_topic(payload: TopicCreate, session: Session = Depends(get_session)) -> EntityRead:
    title = payload.title.strip()
    if not title:
        raise HTTPException(400, "Enter a topic name")

    members: list[tuple[str, EntityType]] = []
    for eid in payload.event_ids:
        ent = session.get(Entity, eid)
        if not ent:
            raise HTTPException(404, f"Event not found: {eid}")
        if ent.type not in _EVENT_LIKE:
            raise HTTPException(400, f"Only events can go in event_ids (got {ent.type})")
        members.append((eid, ent.type))

    for pid in payload.phase_ids:
        ent = session.get(Entity, pid)
        if not ent:
            raise HTTPException(404, f"Phase not found: {pid}")
        if ent.type != EntityType.phase:
            raise HTTPException(400, f"Only phases can go in phase_ids (got {ent.type})")
        members.append((pid, ent.type))

    # Dedupe while preserving order
    seen: set[str] = set()
    unique_members: list[tuple[str, EntityType]] = []
    for mid, mtype in members:
        if mid in seen:
            continue
        seen.add(mid)
        unique_members.append((mid, mtype))

    n_events = sum(1 for _, t in unique_members if t in _EVENT_LIKE)
    n_phases = sum(1 for _, t in unique_members if t == EntityType.phase)

    topic = Entity(
        type=EntityType.topic,
        title=title,
        summary=_topic_summary(n_events, n_phases, payload.summary),
        tags=[],
        attachments=[],
    )
    topic.created_at = utcnow()
    topic.updated_at = utcnow()
    session.add(topic)
    session.flush()
    session.add(ReviewState(entity_id=topic.id))

    for mid, _ in unique_members:
        session.add(
            Link(
                source_id=topic.id,
                target_id=mid,
                relation=RelationType.part_of,
            )
        )

    session.commit()
    session.refresh(topic)
    return EntityRead.model_validate(topic)
