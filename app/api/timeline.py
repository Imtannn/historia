"""Timeline view data — BCE-aware sorted events on an axis."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from app.dates import date_sort_key, format_display_date, parse_historia_date
from app.db import get_session
from app.models import Entity, EntityRead, EntityType, Link

router = APIRouter(tags=["timeline"])


@router.get("/timeline")
def get_timeline(
    timeline_id: Optional[str] = Query(default=None),
    tag: Optional[str] = Query(default=None),
    session: Session = Depends(get_session),
) -> dict:
    """
    Return events (and dated milestones) for a horizontal timeline.
    If timeline_id is set, include entities linked to that timeline entity.
    Otherwise all events (optionally filtered by tag).
    """
    events: list[Entity] = []

    if timeline_id:
        timeline = session.get(Entity, timeline_id)
        if not timeline:
            return {"timeline": None, "items": []}
        # Linked either direction
        links = session.exec(
            select(Link).where(
                (Link.source_id == timeline_id) | (Link.target_id == timeline_id)
            )
        ).all()
        ids: set[str] = set()
        for link in links:
            ids.add(link.target_id if link.source_id == timeline_id else link.source_id)
        # Also children
        children = session.exec(select(Entity).where(Entity.parent_id == timeline_id)).all()
        for c in children:
            ids.add(c.id)
        for eid in ids:
            e = session.get(Entity, eid)
            if e and e.type in (EntityType.event, EntityType.milestone):
                events.append(e)
        timeline_read = EntityRead.model_validate(timeline)
    else:
        events = list(
            session.exec(
                select(Entity).where(
                    (Entity.type == EntityType.event) | (Entity.type == EntityType.milestone)
                )
            ).all()
        )
        timeline_read = None

    if tag:
        tag_l = tag.lower()
        events = [e for e in events if any(t.lower() == tag_l for t in (e.tags or []))]

    events.sort(key=lambda e: (date_sort_key(e.date_start), e.title.lower()))

    # Compute positions 0–100 for dated items; undated get None
    dated = [(e, parse_historia_date(e.date_start)) for e in events]
    years = [p[0] for _, p in dated if p is not None]
    if years:
        lo, hi = min(years), max(years)
        span = max(hi - lo, 1)
    else:
        lo = hi = span = 0

    items = []
    for e, parsed in dated:
        if parsed is None:
            pos = None
        else:
            pos = round(((parsed[0] - lo) / span) * 100, 2) if years else 50.0
        items.append(
            {
                "entity": EntityRead.model_validate(e),
                "display_date": format_display_date(e.date_start),
                "position": pos,
                "sort_year": parsed[0] if parsed else None,
            }
        )

    # List available timeline entities for the picker
    timelines = [
        EntityRead.model_validate(t)
        for t in session.exec(select(Entity).where(Entity.type == EntityType.timeline)).all()
    ]

    return {
        "timeline": timeline_read,
        "items": items,
        "timelines": timelines,
        "range": {"start_year": lo if years else None, "end_year": hi if years else None},
    }
