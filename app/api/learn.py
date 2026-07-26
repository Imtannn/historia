"""Learn API — flashcards, quiz sessions, review submissions."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.db import get_session
from app.learn import answers_match, build_quiz_session, list_flashcards
from app.models import ProgressRead, ReviewStateRead
from app.progress_logic import apply_review

router = APIRouter(prefix="/learn", tags=["learn"])


class ReviewBody(BaseModel):
    entity_id: str
    correct: bool
    xp_amount: int = Field(default=0, ge=0, le=100)
    # For match sets: credit multiple entities
    entity_ids: list[str] = Field(default_factory=list)


class QuizRequest(BaseModel):
    length: int = Field(default=10, ge=1, le=50)
    quiz_type: str = Field(default="mixed")  # mcq | typein | match | mixed
    type: Optional[str] = None
    tag: Optional[str] = None
    place_id: Optional[str] = None
    seed: Optional[str] = None


class CheckAnswerBody(BaseModel):
    quiz_type: str
    answer: Any = None  # str for typein/mcq; dict entity_id->label for match
    expected: Any = None
    entity_id: str
    entity_ids: list[str] = Field(default_factory=list)
    xp_amount: int = Field(default=0, ge=0, le=100)


def _progress_read(progress) -> ProgressRead:
    data = ProgressRead.model_validate(progress)
    data.goal_hit_today = progress.xp_today >= progress.daily_goal_xp
    return data


@router.get("/flashcards")
def get_flashcards(
    type: Optional[str] = None,
    tag: Optional[str] = None,
    place_id: Optional[str] = None,
    limit: int = Query(default=20, ge=1, le=100),
    session: Session = Depends(get_session),
) -> dict:
    cards = list_flashcards(session, type=type, tag=tag, place_id=place_id, limit=limit)
    return {"cards": cards, "count": len(cards)}


@router.post("/review")
def submit_review(body: ReviewBody, session: Session = Depends(get_session)) -> dict:
    ids = body.entity_ids or [body.entity_id]
    last_rs = None
    progress = None
    goal_hit = False
    for i, eid in enumerate(ids):
        # Award XP only once (on first entity)
        xp = body.xp_amount if i == 0 else 0
        last_rs, progress, hit = apply_review(session, eid, body.correct, xp)
        goal_hit = goal_hit or hit

    return {
        "review": ReviewStateRead.model_validate(last_rs) if last_rs else None,
        "progress": _progress_read(progress) if progress else None,
        "goal_just_hit": goal_hit,
        "xp_earned": body.xp_amount if body.correct else 0,
    }


@router.post("/quiz")
def create_quiz(body: QuizRequest, session: Session = Depends(get_session)) -> dict:
    if body.quiz_type not in ("mcq", "typein", "match", "mixed"):
        raise HTTPException(400, "quiz_type must be mcq, typein, match, or mixed")
    return build_quiz_session(
        session,
        length=body.length,
        quiz_type=body.quiz_type,
        type=body.type,
        tag=body.tag,
        place_id=body.place_id,
        seed=body.seed,
    )


@router.post("/check")
def check_answer(body: CheckAnswerBody, session: Session = Depends(get_session)) -> dict:
    """Validate an answer server-side and apply review/XP."""
    correct = False
    if body.quiz_type in ("mcq", "typein"):
        correct = answers_match(str(body.answer or ""), str(body.expected or ""))
    elif body.quiz_type == "match":
        expected = body.expected or {}
        given = body.answer or {}
        if isinstance(expected, dict) and isinstance(given, dict) and expected:
            correct = all(
                answers_match(str(given.get(k, "")), str(v)) for k, v in expected.items()
            )
    else:
        raise HTTPException(400, "Unknown quiz_type")

    ids = body.entity_ids or [body.entity_id]
    last_rs = None
    progress = None
    goal_hit = False
    for i, eid in enumerate(ids):
        xp = body.xp_amount if (correct and i == 0) else 0
        last_rs, progress, hit = apply_review(session, eid, correct, xp)
        goal_hit = goal_hit or hit

    return {
        "correct": correct,
        "progress": _progress_read(progress) if progress else None,
        "goal_just_hit": goal_hit,
        "xp_earned": body.xp_amount if correct else 0,
        "review": ReviewStateRead.model_validate(last_rs) if last_rs else None,
    }
