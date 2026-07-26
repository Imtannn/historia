"""Progress, XP, and streak helpers."""

from __future__ import annotations

from datetime import date, datetime, timezone

from sqlmodel import Session

from app.models import Progress, ReviewState


def today_utc() -> date:
    return datetime.now(timezone.utc).date()


def ensure_progress(session: Session) -> Progress:
    progress = session.get(Progress, 1)
    if progress is None:
        progress = Progress(id=1)
        session.add(progress)
        session.commit()
        session.refresh(progress)
    return progress


def roll_daily_if_needed(progress: Progress, today: date | None = None) -> bool:
    """
    Reset xp_today / handle missed days.
    Returns True if streak was broken (reset to 0).
    """
    today = today or today_utc()
    broken = False
    if progress.last_active_date is None:
        progress.xp_today = 0
        return False

    if progress.last_active_date == today:
        return False

    delta = (today - progress.last_active_date).days
    if delta >= 1:
        # New calendar day — reset today's XP counter
        # If they missed a full day after a goal day, streak breaks when they return
        # without having hit goal... Streak only increments on goal hit.
        # If last_active was yesterday, streak can continue when they hit goal today.
        # If last_active was 2+ days ago, streak resets.
        if delta > 1:
            progress.streak_current = 0
            broken = True
        progress.xp_today = 0
    return broken


def apply_xp(session: Session, amount: int) -> tuple[Progress, bool]:
    """
    Award XP (never negative). Returns (progress, goal_just_hit).
    Streak increments when daily goal is crossed.
    """
    progress = ensure_progress(session)
    today = today_utc()
    roll_daily_if_needed(progress, today)

    if amount < 0:
        amount = 0

    before = progress.xp_today
    progress.xp += amount
    progress.xp_today += amount
    progress.last_active_date = today

    goal_just_hit = before < progress.daily_goal_xp <= progress.xp_today
    if goal_just_hit:
        progress.streak_current += 1
        if progress.streak_current > progress.streak_longest:
            progress.streak_longest = progress.streak_current

    session.add(progress)
    session.commit()
    session.refresh(progress)
    return progress, goal_just_hit


def apply_review(
    session: Session,
    entity_id: str,
    correct: bool,
    xp_amount: int,
) -> tuple[ReviewState, Progress, bool]:
    """Update ReviewState mastery + award XP."""
    rs = session.get(ReviewState, entity_id)
    if rs is None:
        rs = ReviewState(entity_id=entity_id)
        session.add(rs)
        session.flush()

    rs.times_seen += 1
    if correct:
        rs.times_correct += 1
    rs.last_reviewed_at = datetime.now(timezone.utc)
    rs.mastery = round(100.0 * rs.times_correct / rs.times_seen, 1) if rs.times_seen else 0.0
    session.add(rs)

    awarded = xp_amount if correct else 0
    progress, goal_hit = apply_xp(session, awarded)
    session.refresh(rs)
    return rs, progress, goal_hit


XP_FLASHCARD = 2
XP_MCQ = 5
XP_TYPEIN = 8
XP_MATCH = 10
