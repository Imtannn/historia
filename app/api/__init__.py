"""API package — routers assembled here."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/ping")
def ping() -> dict:
    return {"pong": True}
