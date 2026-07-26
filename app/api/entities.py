"""Entity CRUD endpoints."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from app.dates import date_sort_key
from app.db import get_session
from app.models import (
    Entity,
    EntityCreate,
    EntityRead,
    EntityUpdate,
    Link,
    ReviewState,
    utcnow,
)

router = APIRouter(prefix="/entities", tags=["entities"])


def _entity_read(e: Entity) -> EntityRead:
    data = e.model_dump()
    if data.get("tags") is None:
        data["tags"] = []
    if data.get("attachments") is None:
        data["attachments"] = []
    return EntityRead.model_validate(data)


@router.get("", response_model=list[EntityRead])
def list_entities(
    type: Optional[str] = Query(default=None),
    tag: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None),
    parent_id: Optional[str] = Query(default=None),
    session: Session = Depends(get_session),
) -> list[EntityRead]:
    stmt = select(Entity)
    if type:
        stmt = stmt.where(Entity.type == type)
    if parent_id:
        stmt = stmt.where(Entity.parent_id == parent_id)
    rows = list(session.exec(stmt).all())

    if tag:
        tag_l = tag.lower()
        rows = [e for e in rows if any(t.lower() == tag_l for t in (e.tags or []))]

    if q:
        ql = q.lower()
        rows = [
            e
            for e in rows
            if ql in e.title.lower()
            or (e.summary and ql in e.summary.lower())
            or any(ql in t.lower() for t in (e.tags or []))
        ]

    rows.sort(key=lambda e: (date_sort_key(e.date_start), e.title.lower()))
    return [_entity_read(e) for e in rows]


@router.get("/{entity_id}", response_model=EntityRead)
def get_entity(entity_id: str, session: Session = Depends(get_session)) -> EntityRead:
    entity = session.get(Entity, entity_id)
    if not entity:
        raise HTTPException(404, "Entity not found")
    return _entity_read(entity)


@router.post("", response_model=EntityRead, status_code=201)
def create_entity(payload: EntityCreate, session: Session = Depends(get_session)) -> EntityRead:
    data = payload.model_dump(exclude={"link_ids", "link_relation", "id"})
    if data.get("tags") is None:
        data["tags"] = []
    if data.get("attachments") is None:
        data["attachments"] = []
    entity = Entity(**data)
    if payload.id:
        entity.id = payload.id
    entity.created_at = utcnow()
    entity.updated_at = utcnow()
    session.add(entity)
    session.flush()

    # Ensure review state row
    if session.get(ReviewState, entity.id) is None:
        session.add(ReviewState(entity_id=entity.id))

    # Optional quick links from create payload
    for target_id in payload.link_ids:
        if target_id == entity.id:
            continue
        if not session.get(Entity, target_id):
            continue
        session.add(
            Link(
                source_id=entity.id,
                target_id=target_id,
                relation=payload.link_relation,
            )
        )

    session.commit()
    session.refresh(entity)
    return _entity_read(entity)


@router.patch("/{entity_id}", response_model=EntityRead)
def update_entity(
    entity_id: str,
    payload: EntityUpdate,
    session: Session = Depends(get_session),
) -> EntityRead:
    entity = session.get(Entity, entity_id)
    if not entity:
        raise HTTPException(404, "Entity not found")
    updates = payload.model_dump(exclude_unset=True)
    for key, value in updates.items():
        setattr(entity, key, value)
    entity.updated_at = utcnow()
    session.add(entity)
    session.commit()
    session.refresh(entity)
    return _entity_read(entity)


@router.delete("/{entity_id}", status_code=204)
def delete_entity(entity_id: str, session: Session = Depends(get_session)) -> None:
    entity = session.get(Entity, entity_id)
    if not entity:
        raise HTTPException(404, "Entity not found")

    # Remove links involving this entity
    links = session.exec(
        select(Link).where((Link.source_id == entity_id) | (Link.target_id == entity_id))
    ).all()
    for link in links:
        session.delete(link)

    rs = session.get(ReviewState, entity_id)
    if rs:
        session.delete(rs)

    # Clear parent refs pointing here
    children = session.exec(select(Entity).where(Entity.parent_id == entity_id)).all()
    for child in children:
        child.parent_id = None
        session.add(child)

    session.delete(entity)
    session.commit()


@router.get("/{entity_id}/neighbors")
def entity_neighbors(entity_id: str, session: Session = Depends(get_session)) -> dict:
    """Grouped related entities + backlinks for the hub page."""
    entity = session.get(Entity, entity_id)
    if not entity:
        raise HTTPException(404, "Entity not found")

    outgoing = session.exec(select(Link).where(Link.source_id == entity_id)).all()
    incoming = session.exec(select(Link).where(Link.target_id == entity_id)).all()

    def load(eid: str) -> Optional[EntityRead]:
        e = session.get(Entity, eid)
        return _entity_read(e) if e else None

    related: dict[str, list[dict]] = {}
    seen_in_related: set[str] = set()

    def add_related(other: EntityRead, relation, direction: str, link_id: str | None) -> None:
        if other.id in seen_in_related or other.id == entity_id:
            return
        seen_in_related.add(other.id)
        bucket = other.type.value if hasattr(other.type, "value") else str(other.type)
        related.setdefault(bucket, []).append(
            {"entity": other, "relation": relation, "direction": direction, "link_id": link_id}
        )

    for link in outgoing:
        other = load(link.target_id)
        if other:
            add_related(other, link.relation, "out", link.id)

    # Incoming links also populate hub groups (e.g. country → its events)
    for link in incoming:
        other = load(link.source_id)
        if other:
            add_related(other, link.relation, "in", link.id)

    # Children via parent_id
    children = session.exec(select(Entity).where(Entity.parent_id == entity_id)).all()
    for child in children:
        add_related(_entity_read(child), "child", "child", None)

    backlinks = []
    for link in incoming:
        other = load(link.source_id)
        if not other:
            continue
        backlinks.append(
            {"entity": other, "relation": link.relation, "direction": "in", "link_id": link.id}
        )

    # Parent
    parent = load(entity.parent_id) if entity.parent_id else None

    return {
        "entity": _entity_read(entity),
        "parent": parent,
        "related": related,
        "backlinks": backlinks,
    }
