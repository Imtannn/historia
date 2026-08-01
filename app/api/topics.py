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

_EVENT_LIKE = frozenset({EntityType.event, EntityType.milestone})
_TOPIC_MEMBER_SPECS: tuple[tuple[str, frozenset[EntityType], str], ...] = (
    ("event_ids", _EVENT_LIKE, "Event"),
    ("phase_ids", frozenset({EntityType.phase}), "Phase"),
    ("figure_ids", frozenset({EntityType.figure}), "Figure"),
)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'s' if n != 1 else ''}"


def _topic_summary(counts: dict[str, int], custom: str | None) -> str:
    if custom and custom.strip():
        return custom.strip()
    parts = [_plural(n, word) for word, n in counts.items() if n]
    return " · ".join(parts) if parts else "Empty topic — add events, phases, or figures"


def _collect_topic_members(
    session: Session, payload: TopicCreate
) -> list[tuple[str, EntityType]]:
    members: list[tuple[str, EntityType]] = []
    for field_name, allowed, label in _TOPIC_MEMBER_SPECS:
        for mid in getattr(payload, field_name):
            ent = session.get(Entity, mid)
            if not ent:
                raise HTTPException(404, f"{label} not found: {mid}")
            if ent.type not in allowed:
                raise HTTPException(
                    400, f"Only {label.lower()}s can go in {field_name} (got {ent.type})"
                )
            members.append((mid, ent.type))

    seen: set[str] = set()
    unique: list[tuple[str, EntityType]] = []
    for mid, mtype in members:
        if mid in seen:
            continue
        seen.add(mid)
        unique.append((mid, mtype))
    return unique


@router.post("", response_model=EntityRead, status_code=201)
def create_topic(payload: TopicCreate, session: Session = Depends(get_session)) -> EntityRead:
    title = payload.title.strip()
    if not title:
        raise HTTPException(400, "Enter a topic name")

    unique_members = _collect_topic_members(session, payload)
    counts = {
        "event": sum(1 for _, t in unique_members if t in _EVENT_LIKE),
        "phase": sum(1 for _, t in unique_members if t == EntityType.phase),
        "figure": sum(1 for _, t in unique_members if t == EntityType.figure),
    }

    topic = Entity(
        type=EntityType.topic,
        title=title,
        summary=_topic_summary(counts, payload.summary),
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
