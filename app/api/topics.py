"""Topic grouping endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.db import get_session
from app.models import (
    Entity,
    EntityRead,
    EntityType,
    Link,
    RelationType,
    ReviewState,
    TopicCreate,
    TopicMemberOrderUpdate,
    utcnow,
)

router = APIRouter(prefix="/topics", tags=["topics"])

_EVENT_LIKE = frozenset({EntityType.event, EntityType.milestone})
_TOPIC_MEMBER_KINDS = frozenset({"event", "phase", "figure", "milestone"})
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


def apply_topic_member_order(
    session: Session, topic_id: str, payload: TopicMemberOrderUpdate
) -> dict:
    topic = session.get(Entity, topic_id)
    if not topic or topic.type != EntityType.topic:
        raise HTTPException(404, "Topic not found")

    kind = payload.kind.strip().lower()
    if kind not in _TOPIC_MEMBER_KINDS:
        raise HTTPException(400, "kind must be event, phase, figure, or milestone")

    allowed = (
        _EVENT_LIKE
        if kind == "event"
        else frozenset({EntityType.milestone})
        if kind == "milestone"
        else frozenset({EntityType.phase if kind == "phase" else EntityType.figure})
    )

    outgoing = session.exec(
        select(Link).where(
            Link.source_id == topic_id,
            Link.relation == RelationType.part_of,
        )
    ).all()
    incoming = session.exec(
        select(Link).where(
            Link.target_id == topic_id,
            Link.relation == RelationType.part_of,
        )
    ).all()
    by_member: dict[str, Link] = {}
    for link in outgoing:
        by_member[link.target_id] = link
    for link in incoming:
        by_member.setdefault(link.source_id, link)

    seen: set[str] = set()
    ordered_ids: list[str] = []
    for eid in payload.ordered_entity_ids:
        if eid in seen:
            continue
        seen.add(eid)
        ordered_ids.append(eid)

    for eid in ordered_ids:
        link = by_member.get(eid)
        if not link:
            raise HTTPException(400, f"Not a member of this topic: {eid}")
        ent = session.get(Entity, eid)
        if not ent or ent.type not in allowed:
            raise HTTPException(400, f"Invalid {kind} member: {eid}")

    for idx, eid in enumerate(ordered_ids):
        link = by_member[eid]
        link.sort_order = idx
        session.add(link)

    session.commit()
    return {"ok": True, "kind": kind, "count": len(ordered_ids)}


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

    next_order: dict[EntityType, int] = {}
    for mid, mtype in unique_members:
        order = next_order.get(mtype, 0)
        next_order[mtype] = order + 1
        session.add(
            Link(
                source_id=topic.id,
                target_id=mid,
                relation=RelationType.part_of,
                sort_order=order,
            )
        )

    session.commit()
    session.refresh(topic)
    return EntityRead.model_validate(topic)


@router.patch("/{topic_id}/member-order", response_model=dict)
def reorder_topic_members(
    topic_id: str,
    payload: TopicMemberOrderUpdate,
    session: Session = Depends(get_session),
) -> dict:
    return apply_topic_member_order(session, topic_id, payload)
