"""Progress and dashboard endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from app.db import get_session
from app.models import Entity, EntityRead, ProgressRead, ProgressUpdate, ReviewState
from app.progress_logic import ensure_progress, roll_daily_if_needed

router = APIRouter(tags=["progress"])


def _progress_read(progress) -> ProgressRead:
    data = progress.model_dump()
    if data.get("categories") is None:
        data["categories"] = []
    validated = ProgressRead.model_validate(data)
    validated.goal_hit_today = progress.xp_today >= progress.daily_goal_xp
    return validated


@router.get("/progress", response_model=ProgressRead)
def get_progress(session: Session = Depends(get_session)) -> ProgressRead:
    progress = ensure_progress(session)
    roll_daily_if_needed(progress)
    session.add(progress)
    session.commit()
    session.refresh(progress)
    return _progress_read(progress)


@router.patch("/progress", response_model=ProgressRead)
def update_progress(
    payload: ProgressUpdate,
    session: Session = Depends(get_session),
) -> ProgressRead:
    progress = ensure_progress(session)
    if payload.daily_goal_xp is not None:
        progress.daily_goal_xp = payload.daily_goal_xp
    if payload.categories is not None:
        progress.categories = [str(c).strip() for c in payload.categories if str(c).strip()]
    session.add(progress)
    session.commit()
    session.refresh(progress)
    return _progress_read(progress)


@router.get("/dashboard")
def dashboard(session: Session = Depends(get_session)) -> dict:
    progress = ensure_progress(session)
    roll_daily_if_needed(progress)
    session.add(progress)
    session.commit()
    session.refresh(progress)

    from app.models import EntityType

    entities = list(session.exec(select(Entity)).all())
    events = [e for e in entities if e.type == EntityType.event]
    reviews = {r.entity_id: r for r in session.exec(select(ReviewState)).all()}

    def read(e: Entity) -> EntityRead:
        return EntityRead.model_validate(e)

    recent = sorted(events, key=lambda e: e.created_at, reverse=True)[:6]

    weak = []
    for e in events:
        rs = reviews.get(e.id)
        mastery = rs.mastery if rs and rs.times_seen else 0.0
        seen = rs.times_seen if rs else 0
        weak.append({"entity": read(e), "mastery": mastery, "times_seen": seen})
    weak.sort(key=lambda x: (x["times_seen"] == 0, x["mastery"], x["entity"].title.lower()))
    weak = weak[:5]

    by_type: dict[str, int] = {}
    for e in entities:
        by_type[e.type.value] = by_type.get(e.type.value, 0) + 1

    return {
        "progress": _progress_read(progress),
        "entity_count": len(events),
        "by_type": by_type,
        "recent": [read(e) for e in recent],
        "weakest": weak,
    }
