"""Shared link-role helpers for API routes."""

from __future__ import annotations

from fastapi import HTTPException

from app.models import ROLE_LINK_RELATIONS, RelationType, normalize_link_role

__all__ = ("ROLE_LINK_RELATIONS", "http_normalize_role")


def http_normalize_role(role: str | None, relation: RelationType) -> str | None:
    try:
        return normalize_link_role(role, relation)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
