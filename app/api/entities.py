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
    EntityType,
    EntityUpdate,
    INVOLVE_ROLES,
    Link,
    RelationType,
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


def _normalize_role(role: str | None) -> str | None:
    if role is None:
        return None
    r = str(role).strip().lower()
    if not r:
        return None
    if r not in INVOLVE_ROLES:
        raise HTTPException(400, f"Invalid involve role: {role}")
    return r


def _add_typed_links(
    session: Session,
    source_id: str,
    target_ids: list[str],
    expected_type: EntityType,
    relation: RelationType,
    roles: dict[str, str] | None = None,
) -> None:
    roles = roles or {}
    for tid in target_ids:
        if tid == source_id:
            continue
        target = session.get(Entity, tid)
        if not target:
            raise HTTPException(404, f"Linked entity not found: {tid}")
        if target.type != expected_type:
            raise HTTPException(
                400,
                f"Expected {expected_type.value}, got {target.type.value} ({target.title})",
            )
        role = _normalize_role(roles.get(tid)) if relation == RelationType.involves else None
        existing = session.exec(
            select(Link).where(
                Link.source_id == source_id,
                Link.target_id == tid,
                Link.relation == relation,
            )
        ).first()
        if existing:
            if relation == RelationType.involves and tid in roles:
                existing.role = role
                session.add(existing)
            continue
        session.add(Link(source_id=source_id, target_id=tid, relation=relation, role=role))


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
    data = payload.model_dump(
        exclude={
            "link_ids",
            "link_relation",
            "id",
            "period_ids",
            "phase_ids",
            "country_ids",
            "figure_ids",
            "figure_roles",
        }
    )
    if data.get("tags") is None:
        data["tags"] = []
    if data.get("attachments") is None:
        data["attachments"] = []

    # Events must belong to at least one period, country, or figure
    if payload.type == EntityType.event:
        if not (payload.period_ids or payload.country_ids or payload.figure_ids):
            raise HTTPException(
                400,
                "An event must belong to at least one period, country, or figure",
            )

    entity = Entity(**data)
    if payload.id:
        entity.id = payload.id
    entity.created_at = utcnow()
    entity.updated_at = utcnow()
    session.add(entity)
    session.flush()

    if session.get(ReviewState, entity.id) is None:
        session.add(ReviewState(entity_id=entity.id))

    _add_typed_links(
        session, entity.id, payload.period_ids, EntityType.period, RelationType.part_of
    )
    _add_typed_links(
        session, entity.id, payload.phase_ids, EntityType.phase, RelationType.part_of
    )
    _add_typed_links(
        session, entity.id, payload.country_ids, EntityType.place, RelationType.occurred_in
    )
    _add_typed_links(
        session, entity.id, payload.figure_ids, EntityType.figure, RelationType.involves, payload.figure_roles
    )

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

    updates = payload.model_dump(
        exclude_unset=True,
        exclude={
            "period_ids",
            "phase_ids",
            "country_ids",
            "figure_ids",
            "figure_roles",
            "link_ids",
            "link_relation",
        },
    )
    for key, value in updates.items():
        setattr(entity, key, value)
    entity.updated_at = utcnow()
    session.add(entity)

    # Replace belonging links when provided (events / phases linking to periods)
    replacing_belong = any(
        x is not None
        for x in (payload.period_ids, payload.phase_ids, payload.country_ids, payload.figure_ids)
    )
    if replacing_belong:
        if entity.type == EntityType.event:
            period_ids = payload.period_ids if payload.period_ids is not None else []
            phase_ids = payload.phase_ids if payload.phase_ids is not None else []
            country_ids = payload.country_ids if payload.country_ids is not None else []
            figure_ids = payload.figure_ids if payload.figure_ids is not None else []
            if not (period_ids or country_ids or figure_ids):
                raise HTTPException(
                    400,
                    "An event must belong to at least one period, country, or figure",
                )
            _replace_links_of_relations(
                session,
                entity_id,
                [
                    (RelationType.part_of, period_ids, EntityType.period, None),
                    (RelationType.part_of, phase_ids, EntityType.phase, None),
                    (RelationType.occurred_in, country_ids, EntityType.place, None),
                    (
                        RelationType.involves,
                        figure_ids,
                        EntityType.figure,
                        payload.figure_roles if payload.figure_roles is not None else {},
                    ),
                ],
            )
        elif entity.type == EntityType.phase and payload.period_ids is not None:
            _replace_links_of_relations(
                session,
                entity_id,
                [
                    (RelationType.part_of, payload.period_ids, EntityType.period, None),
                ],
            )

    if payload.link_ids is not None:
        # Replace related_to outgoing links
        old = session.exec(
            select(Link).where(
                Link.source_id == entity_id,
                Link.relation == payload.link_relation,
            )
        ).all()
        for link in old:
            session.delete(link)
        session.flush()
        for target_id in payload.link_ids:
            if target_id == entity_id:
                continue
            if not session.get(Entity, target_id):
                continue
            session.add(
                Link(
                    source_id=entity_id,
                    target_id=target_id,
                    relation=payload.link_relation,
                )
            )

    session.commit()
    session.refresh(entity)
    return _entity_read(entity)


def _replace_links_of_relations(
    session: Session,
    source_id: str,
    specs: list[tuple[RelationType, list[str], EntityType, dict[str, str] | None]],
) -> None:
    """Replace outgoing links for each (relation, ids, expected_type) without
    wiping other target types that share the same relation (e.g. period + phase part_of).
    """
    for relation, _ids, expected_type, _roles in specs:
        old = session.exec(
            select(Link).where(Link.source_id == source_id, Link.relation == relation)
        ).all()
        for link in old:
            target = session.get(Entity, link.target_id)
            if target is None or target.type == expected_type:
                session.delete(link)
    session.flush()
    for relation, ids, expected_type, roles in specs:
        _add_typed_links(session, source_id, ids, expected_type, relation, roles)


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

    def add_related(
        other: EntityRead,
        relation,
        direction: str,
        link_id: str | None,
        role: str | None = None,
    ) -> None:
        if other.id in seen_in_related or other.id == entity_id:
            return
        seen_in_related.add(other.id)
        bucket = other.type.value if hasattr(other.type, "value") else str(other.type)
        related.setdefault(bucket, []).append(
            {
                "entity": other,
                "relation": relation,
                "direction": direction,
                "link_id": link_id,
                "role": role,
            }
        )

    for link in outgoing:
        other = load(link.target_id)
        if other:
            add_related(other, link.relation, "out", link.id, getattr(link, "role", None))

    # Incoming links also populate hub groups (e.g. country → its events)
    for link in incoming:
        other = load(link.source_id)
        if other:
            add_related(other, link.relation, "in", link.id, getattr(link, "role", None))

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
            {
                "entity": other,
                "relation": link.relation,
                "direction": "in",
                "link_id": link.id,
                "role": getattr(link, "role", None),
            }
        )

    # Parent
    parent = load(entity.parent_id) if entity.parent_id else None

    # Life timeline for figures: involves events, chronological
    life_events = []
    if entity.type == EntityType.figure:
        for item in related.get("event", []):
            rel = item.get("relation")
            rel_s = rel.value if hasattr(rel, "value") else str(rel)
            if rel_s == RelationType.involves.value:
                life_events.append(item)
        life_events.sort(
            key=lambda item: (
                date_sort_key(item["entity"].date_start),
                item["entity"].title.lower(),
            )
        )

    return {
        "entity": _entity_read(entity),
        "parent": parent,
        "related": related,
        "backlinks": backlinks,
        "life_events": life_events,
    }
