"""Entity CRUD endpoints."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from app.api.roles import http_normalize_role
from app.dates import date_sort_key, parse_historia_date
from app.db import get_session
from app.catalog import COUNTRIES, EMPIRES
from app.models import (
    Entity,
    EntityCreate,
    EntityRead,
    EntityType,
    EntityUpdate,
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
    if data.get("country_names") is None:
        data["country_names"] = []
    if not data["country_names"] and data.get("country_name"):
        data["country_names"] = [data["country_name"]]
    return EntityRead.model_validate(data)


def _normalize_country_names(
    country_names: Optional[list[str]] = None,
    country_name: Optional[str] = None,
) -> list[str]:
    names = [str(c).strip() for c in (country_names or []) if str(c).strip()]
    if not names and (country_name or "").strip():
        names = [country_name.strip()]
    return names


def _flag_for_country_name(name: str) -> Optional[str]:
    key = name.strip().lower()
    for country_name, flag in COUNTRIES:
        if country_name.lower() == key:
            return flag
    for empire_name, flag, _ in EMPIRES:
        if empire_name.lower() == key:
            return flag
    return None


def _find_place_by_title(session: Session, name: str) -> Optional[Entity]:
    key = name.strip().lower()
    if not key:
        return None
    for place in session.exec(select(Entity).where(Entity.type == EntityType.place)).all():
        if place.title.strip().lower() == key:
            return place
    return None


def _ensure_place(session: Session, name: str) -> Entity:
    cleaned = name.strip()
    if not cleaned:
        raise HTTPException(400, "Country name cannot be empty")
    existing = _find_place_by_title(session, cleaned)
    if existing:
        return existing
    flag = _flag_for_country_name(cleaned)
    place = Entity(
        type=EntityType.place,
        title=cleaned,
        summary=flag,
        tags=[],
        attachments=[],
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    session.add(place)
    session.flush()
    if session.get(ReviewState, place.id) is None:
        session.add(ReviewState(entity_id=place.id))
    return place


def _replace_place_links(
    session: Session,
    source_id: str,
    place_ids: list[str],
    relation: RelationType,
) -> None:
    old = session.exec(
        select(Link).where(Link.source_id == source_id, Link.relation == relation)
    ).all()
    for link in old:
        target = session.get(Entity, link.target_id)
        if target and target.type == EntityType.place:
            session.delete(link)
    session.flush()
    if place_ids:
        _add_typed_links(session, source_id, place_ids, EntityType.place, relation)


def _sync_event_country_links(session: Session, event: Entity) -> None:
    if event.type != EntityType.event:
        return
    names = _normalize_country_names(event.country_names, event.country_name)
    place_ids = [_ensure_place(session, name).id for name in names]
    _replace_place_links(session, event.id, place_ids, RelationType.occurred_in)


def _sync_figure_country_link(session: Session, figure: Entity) -> None:
    if figure.type != EntityType.figure:
        return
    place_name = (figure.place_name or "").strip()
    place_ids = [_ensure_place(session, place_name).id] if place_name else []
    _replace_place_links(session, figure.id, place_ids, RelationType.involves)


def _signed_year(value: Optional[str]) -> Optional[int]:
    parsed = parse_historia_date(value)
    return parsed[0] if parsed else None


def _year_range(entity: Entity) -> Optional[tuple[int, int]]:
    y0 = _signed_year(entity.date_start)
    y1 = _signed_year(entity.date_end)
    if y0 is None and y1 is None:
        return None
    if y0 is None:
        return (y1, y1)  # type: ignore[return-value]
    if y1 is None:
        return (y0, y0)
    return (min(y0, y1), max(y0, y1))


def _year_range_from_dates(
    date_start: Optional[str],
    date_end: Optional[str],
) -> Optional[tuple[int, int]]:
    y0 = _signed_year(date_start)
    y1 = _signed_year(date_end)
    if y0 is None and y1 is None:
        return None
    if y0 is None:
        return (y1, y1)  # type: ignore[return-value]
    if y1 is None:
        return (y0, y0)
    return (min(y0, y1), max(y0, y1))


def _entity_time_ranges(entity: Entity) -> list[tuple[int, int]]:
    """Life dates and reign dates (figures) as separate ranges for overlap checks."""
    ranges: list[tuple[int, int]] = []
    life = _year_range(entity)
    if life is not None:
        ranges.append(life)
    if entity.type == EntityType.figure:
        reign = _year_range_from_dates(entity.reign_start, entity.reign_end)
        if reign is not None:
            ranges.append(reign)
    return ranges



def _ranges_overlap(a: tuple[int, int], b: tuple[int, int]) -> bool:
    """True when ranges share interior years. Endpoint-only touch does not count
    (so Prehistory …3300 BC does not claim Bronze Age 3300 BC…)."""
    return a[0] < b[1] and a[1] > b[0]


_DURING_TIME_TYPES = (
    EntityType.event,
    EntityType.milestone,
    EntityType.figure,
    EntityType.phase,
    EntityType.period,
)


def _collect_during_time(
    session: Session,
    entity: Entity,
    exclude_ids: Optional[set[str]] = None,
) -> list[dict]:
    """All dated notes from elsewhere whose timeline overlaps this entity's range."""
    entity_ranges = _entity_time_ranges(entity)
    if not entity_ranges:
        return []

    skip: set[str] = {entity.id}
    if exclude_ids:
        skip |= exclude_ids
    for child in session.exec(select(Entity).where(Entity.parent_id == entity.id)).all():
        skip.add(child.id)

    candidates = list(
        session.exec(
            select(Entity).where(
                Entity.type.in_(_DURING_TIME_TYPES)  # type: ignore[attr-defined]
            )
        ).all()
    )

    overlapping: list[Entity] = []
    for other in candidates:
        if other.id in skip:
            continue
        other_ranges = _entity_time_ranges(other) if other.type == EntityType.figure else []
        if not other_ranges:
            other_range = _year_range(other)
            if other_range is not None:
                other_ranges = [other_range]
        if not other_ranges:
            continue
        if not any(
            _ranges_overlap(er, orng) for er in entity_ranges for orng in other_ranges
        ):
            continue
        overlapping.append(other)

    milestone_parent_ids = {
        m.parent_id for m in overlapping if m.type == EntityType.milestone and m.parent_id
    }

    results: list[dict] = []
    for other in overlapping:
        if other.type == EntityType.event and other.id in milestone_parent_ids:
            continue
        parent = None
        if other.type == EntityType.milestone and other.parent_id:
            p = session.get(Entity, other.parent_id)
            if p:
                parent = _entity_read(p)
        results.append({"entity": _entity_read(other), "parent": parent})

    results.sort(
        key=lambda item: (
            date_sort_key(item["entity"].date_start),
            item["entity"].title.lower(),
        )
    )
    return results


def _sync_overlapping_phases_for_period(session: Session, period: Entity) -> None:
    """
    Keep phase → period part_of links in sync with date overlap.

    Creating a period after its phases used to leave them unlinked, because
    auto-map only ran when saving a phase. This backfills (and prunes) links
    whenever a period is created or its dates change.
    """
    if period.type != EntityType.period:
        return
    period_range = _year_range(period)
    if period_range is None:
        return

    phases = list(session.exec(select(Entity).where(Entity.type == EntityType.phase)).all())
    overlapping_ids = {
        phase.id
        for phase in phases
        if (pr := _year_range(phase)) is not None and _ranges_overlap(pr, period_range)
    }

    # Incoming part_of links: phase → this period
    incoming = session.exec(
        select(Link).where(
            Link.target_id == period.id,
            Link.relation == RelationType.part_of,
        )
    ).all()
    for link in incoming:
        source = session.get(Entity, link.source_id)
        if source is None or source.type != EntityType.phase:
            continue
        if link.source_id not in overlapping_ids:
            session.delete(link)

    session.flush()

    existing_sources = {
        link.source_id
        for link in session.exec(
            select(Link).where(
                Link.target_id == period.id,
                Link.relation == RelationType.part_of,
            )
        ).all()
    }
    for phase_id in overlapping_ids:
        if phase_id in existing_sources:
            continue
        session.add(
            Link(
                source_id=phase_id,
                target_id=period.id,
                relation=RelationType.part_of,
            )
        )


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
        role = http_normalize_role(roles.get(tid), relation) if tid in roles else None
        existing = session.exec(
            select(Link).where(
                Link.source_id == source_id,
                Link.target_id == tid,
                Link.relation == relation,
            )
        ).first()
        if existing:
            if tid in roles:
                existing.role = role
                session.add(existing)
            continue
        session.add(Link(source_id=source_id, target_id=tid, relation=relation, role=role))


def _country_and_figure_relations(entity_type: EntityType) -> tuple[RelationType, RelationType]:
    """Figure countries use involves; figure↔figure uses related_to. Events use occurred_in / involves."""
    if entity_type == EntityType.figure:
        return RelationType.involves, RelationType.related_to
    return RelationType.occurred_in, RelationType.involves


@router.get("", response_model=list[EntityRead])
def list_entities(
    type: Optional[str] = Query(default=None),
    tag: Optional[str] = Query(default=None),
    category: Optional[str] = Query(default=None),
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

    if category:
        cat_l = category.lower()
        rows = [e for e in rows if (e.category or "").lower() == cat_l]

    if q:
        ql = q.lower()
        rows = [
            e
            for e in rows
            if ql in e.title.lower()
            or (e.summary and ql in e.summary.lower())
            or (e.country_name and ql in e.country_name.lower())
            or any(ql in c.lower() for c in (e.country_names or []))
            or (e.place_name and ql in e.place_name.lower())
            or (e.category and ql in e.category.lower())
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

    # Events need at least one anchor: period, phase, figure link, or country
    if payload.type == EntityType.event:
        country_names = _normalize_country_names(payload.country_names, payload.country_name)
        if not (
            payload.period_ids
            or payload.phase_ids
            or payload.country_ids
            or payload.figure_ids
            or country_names
        ):
            raise HTTPException(
                400,
                "An event needs a country, or at least one period, phase, or figure",
            )
        if country_names:
            data["country_names"] = country_names
            data["country_name"] = ", ".join(country_names)

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
    country_rel, figure_rel = _country_and_figure_relations(entity.type)
    _add_typed_links(
        session, entity.id, payload.country_ids, EntityType.place, country_rel
    )
    _add_typed_links(
        session,
        entity.id,
        payload.figure_ids,
        EntityType.figure,
        figure_rel,
        payload.figure_roles,
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

    if entity.type == EntityType.period:
        _sync_overlapping_phases_for_period(session, entity)

    if entity.type == EntityType.event:
        _sync_event_country_links(session, entity)
    elif entity.type == EntityType.figure and (entity.place_name or "").strip():
        _sync_figure_country_link(session, entity)

    session.commit()
    session.refresh(entity)
    return _entity_read(entity)


@router.post("/sync-country-places")
def sync_country_places(session: Session = Depends(get_session)) -> dict:
    """Ensure place entities exist for all free-text country names on events and figures."""
    events = session.exec(select(Entity).where(Entity.type == EntityType.event)).all()
    figures = session.exec(select(Entity).where(Entity.type == EntityType.figure)).all()
    for event in events:
        _sync_event_country_links(session, event)
    for figure in figures:
        if (figure.place_name or "").strip():
            _sync_figure_country_link(session, figure)
    session.commit()
    return {"ok": True, "synced_events": len(events), "synced_figures": len(figures)}


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
    if payload.country_names is not None or payload.country_name is not None:
        names = _normalize_country_names(entity.country_names, entity.country_name)
        entity.country_names = names
        entity.country_name = ", ".join(names) if names else None
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
            country_names = _normalize_country_names(entity.country_names, entity.country_name)
            if not (period_ids or phase_ids or country_ids or figure_ids or country_names):
                raise HTTPException(
                    400,
                    "An event needs a country, or at least one period, phase, or figure",
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
        elif entity.type == EntityType.figure:
            country_rel, figure_rel = _country_and_figure_relations(EntityType.figure)
            specs: list[tuple[RelationType, list[str], EntityType, dict[str, str] | None]] = []
            if payload.country_ids is not None:
                specs.append((country_rel, payload.country_ids, EntityType.place, None))
            if payload.figure_ids is not None:
                specs.append(
                    (
                        figure_rel,
                        payload.figure_ids,
                        EntityType.figure,
                        payload.figure_roles if payload.figure_roles is not None else {},
                    )
                )
            if specs:
                _replace_links_of_relations(session, entity_id, specs)

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

    if entity.type == EntityType.period:
        _sync_overlapping_phases_for_period(session, entity)

    if entity.type == EntityType.event:
        _sync_event_country_links(session, entity)
    elif entity.type == EntityType.figure and (
        payload.place_name is not None or (entity.place_name or "").strip()
    ):
        _sync_figure_country_link(session, entity)

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
        "during_time": _collect_during_time(session, entity, seen_in_related),
    }
