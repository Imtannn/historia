"""Timeline view data — BCE-aware world axis with period bands."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from app.dates import date_sort_key, format_display_date, parse_historia_date
from app.db import get_session
from app.models import Entity, EntityRead, EntityType, Link

router = APIRouter(tags=["timeline"])

# Soft earth washes for period bands (brand-compatible, not purple)
_BAND_COLORS = [
    ("#C45C26", "rgba(196,92,38,0.14)"),
    ("#8B6914", "rgba(139,105,20,0.12)"),
    ("#5C6B4A", "rgba(92,107,74,0.12)"),
    ("#6B4C3A", "rgba(107,76,58,0.12)"),
    ("#3D5A6C", "rgba(61,90,108,0.12)"),
    ("#8B3A12", "rgba(139,58,18,0.12)"),
]

# Cooler / lighter washes for phase bands (nested under periods)
_PHASE_BAND_COLORS = [
    ("#5C6B4A", "rgba(92,107,74,0.18)"),
    ("#3D5A6C", "rgba(61,90,108,0.16)"),
    ("#6B4C3A", "rgba(107,76,58,0.16)"),
    ("#8B6914", "rgba(139,105,20,0.15)"),
    ("#C45C26", "rgba(196,92,38,0.12)"),
]


def _year(value: Optional[str]) -> Optional[int]:
    parsed = parse_historia_date(value)
    return parsed[0] if parsed else None


def _pct(year: float, lo: float, hi: float) -> float:
    span = max(hi - lo, 1.0)
    return round(((year - lo) / span) * 100.0, 3)


def _band_payload(entity: Entity, lo: float, hi: float, years: list[int], stroke: str, fill: str) -> Optional[dict]:
    y0 = _year(entity.date_start)
    y1 = _year(entity.date_end)
    if y0 is None or y1 is None or not years:
        return None
    left = _pct(min(y0, y1), lo, hi)
    right = _pct(max(y0, y1), lo, hi)
    return {
        "entity": EntityRead.model_validate(entity),
        "start_year": min(y0, y1),
        "end_year": max(y0, y1),
        "left": left,
        "width": max(right - left, 0.35),
        "color": stroke,
        "fill": fill,
        "display_start": format_display_date(entity.date_start),
        "display_end": format_display_date(entity.date_end),
    }


@router.get("/timeline")
def get_timeline(
    timeline_id: Optional[str] = Query(default=None),
    tag: Optional[str] = Query(default=None),
    session: Session = Depends(get_session),
) -> dict:
    """
    World timeline payload: dated events/milestones, period bands, axis ticks.
    """
    events: list[Entity] = []

    if timeline_id:
        timeline = session.get(Entity, timeline_id)
        if not timeline:
            return {"timeline": None, "items": [], "periods": [], "phases": [], "ticks": []}
        links = session.exec(
            select(Link).where(
                (Link.source_id == timeline_id) | (Link.target_id == timeline_id)
            )
        ).all()
        ids: set[str] = set()
        for link in links:
            ids.add(link.target_id if link.source_id == timeline_id else link.source_id)
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

    periods = list(
        session.exec(select(Entity).where(Entity.type == EntityType.period)).all()
    )
    phases = list(
        session.exec(select(Entity).where(Entity.type == EntityType.phase)).all()
    )

    years: list[int] = []
    for e in events:
        y0 = _year(e.date_start)
        y1 = _year(e.date_end)
        if y0 is not None:
            years.append(y0)
        if y1 is not None:
            years.append(y1)
    for p in periods + phases:
        y0 = _year(p.date_start)
        y1 = _year(p.date_end)
        if y0 is not None:
            years.append(y0)
        if y1 is not None:
            years.append(y1)

    if years:
        lo, hi = float(min(years)), float(max(years))
        pad = max((hi - lo) * 0.04, 5.0)
        lo -= pad
        hi += pad
    else:
        lo = hi = 0.0

    items = []
    for e in events:
        y0 = _year(e.date_start)
        y1 = _year(e.date_end)
        if y0 is None:
            pos = None
            pos_end = None
        else:
            pos = _pct(y0, lo, hi) if years else 50.0
            pos_end = _pct(y1, lo, hi) if y1 is not None else None
        items.append(
            {
                "entity": EntityRead.model_validate(e),
                "display_date": format_display_date(e.date_start),
                "display_end": format_display_date(e.date_end) if e.date_end else None,
                "position": pos,
                "position_end": pos_end,
                "sort_year": y0,
                "end_year": y1,
            }
        )

    period_bands = []
    for i, p in enumerate(sorted(periods, key=lambda x: date_sort_key(x.date_start))):
        stroke, fill = _BAND_COLORS[i % len(_BAND_COLORS)]
        band = _band_payload(p, lo, hi, years, stroke, fill)
        if band:
            period_bands.append(band)

    phase_bands = []
    for i, p in enumerate(sorted(phases, key=lambda x: date_sort_key(x.date_start))):
        stroke, fill = _PHASE_BAND_COLORS[i % len(_PHASE_BAND_COLORS)]
        band = _band_payload(p, lo, hi, years, stroke, fill)
        if band:
            phase_bands.append(band)

    ticks = []
    if years:
        span = hi - lo
        rough = span / 10
        mag = 10 ** max(0, len(str(int(abs(rough)))) - 1) if rough else 1
        step = max(mag, 1)
        for candidate in (1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000):
            if candidate >= rough * 0.6:
                step = candidate
                break
        start_tick = int(lo // step) * step
        y = start_tick
        while y <= hi + step:
            if lo <= y <= hi:
                ticks.append(
                    {
                        "year": y,
                        "position": _pct(y, lo, hi),
                        "label": f"{abs(y)} BC" if y < 0 else f"{y} AC",
                    }
                )
            y += step

    timelines = [
        EntityRead.model_validate(t)
        for t in session.exec(select(Entity).where(Entity.type == EntityType.timeline)).all()
    ]

    dated_count = sum(1 for i in items if i["position"] is not None)

    return {
        "timeline": timeline_read,
        "items": items,
        "periods": period_bands,
        "phases": phase_bands,
        "ticks": ticks,
        "timelines": timelines,
        "range": {
            "start_year": int(lo) if years else None,
            "end_year": int(hi) if years else None,
        },
        "stats": {
            "events": sum(1 for e in events if e.type == EntityType.event),
            "milestones": sum(1 for e in events if e.type == EntityType.milestone),
            "periods": len(period_bands),
            "phases": len(phase_bands),
            "dated": dated_count,
        },
    }
