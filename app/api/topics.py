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


@router.post("", response_model=EntityRead, status_code=201)
def create_topic(payload: TopicCreate, session: Session = Depends(get_session)) -> EntityRead:
    if not payload.event_ids:
        raise HTTPException(400, "Select at least one event to group")

    for eid in payload.event_ids:
        ev = session.get(Entity, eid)
        if not ev:
            raise HTTPException(404, f"Event not found: {eid}")
        if ev.type != EntityType.event:
            raise HTTPException(400, f"Only events can be grouped (got {ev.type})")

    topic = Entity(
        type=EntityType.topic,
        title=payload.title.strip(),
        summary=f"{len(payload.event_ids)} events",
        tags=[],
        attachments=[],
    )
    topic.created_at = utcnow()
    topic.updated_at = utcnow()
    session.add(topic)
    session.flush()
    session.add(ReviewState(entity_id=topic.id))

    for eid in payload.event_ids:
        session.add(
            Link(
                source_id=topic.id,
                target_id=eid,
                relation=RelationType.part_of,
            )
        )

    session.commit()
    session.refresh(topic)
    return EntityRead.model_validate(topic)
