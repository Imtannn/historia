"""Progress and dashboard endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from app.db import get_session
from app.models import Entity, EntityRead, ProgressRead, ProgressUpdate, ReviewState
from app.progress_logic import ensure_progress, roll_daily_if_needed

router = APIRouter(tags=["progress"])


def _progress_read(progress) -> ProgressRead:
    data = ProgressRead.model_validate(progress)
    data.goal_hit_today = progress.xp_today >= progress.daily_goal_xp
    return data


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

    entities = list(session.exec(select(Entity)).all())
    reviews = {r.entity_id: r for r in session.exec(select(ReviewState)).all()}

    recent = sorted(entities, key=lambda e: e.created_at, reverse=True)[:6]

    # Weakest topics: lowest mastery among reviewed, or unseen with cards
    weak = []
    for e in entities:
        rs = reviews.get(e.id)
        mastery = rs.mastery if rs and rs.times_seen else 0.0
        seen = rs.times_seen if rs else 0
        weak.append({"entity": EntityRead.model_validate(e), "mastery": mastery, "times_seen": seen})
    weak.sort(key=lambda x: (x["times_seen"] == 0, x["mastery"], x["entity"].title.lower()))
    weak = weak[:5]

    by_type: dict[str, int] = {}
    for e in entities:
        by_type[e.type.value] = by_type.get(e.type.value, 0) + 1

    return {
        "progress": _progress_read(progress),
        "entity_count": len(entities),
        "by_type": by_type,
        "recent": [EntityRead.model_validate(e) for e in recent],
        "weakest": weak,
    }
