"""Catalog API — selectable countries, periods, figures."""

from __future__ import annotations

from fastapi import APIRouter

from app.catalog import catalog_payload

router = APIRouter(tags=["catalog"])


@router.get("/catalog")
def get_catalog() -> dict:
    return catalog_payload()
