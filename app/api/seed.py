"""Seed endpoint."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from app.db import get_session
from app.seed import seed_sample

router = APIRouter(tags=["seed"])


@router.post("/seed")
def load_seed(session: Session = Depends(get_session)) -> dict:
    result = seed_sample(session)
    if not result.get("ok"):
        raise HTTPException(400, result.get("reason", "Could not seed"))
    return result
