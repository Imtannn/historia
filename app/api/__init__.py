"""API package — routers assembled here."""

from fastapi import APIRouter

from app.api import backup, entities, links, markdown

router = APIRouter()
router.include_router(entities.router)
router.include_router(links.router)
router.include_router(backup.router)
router.include_router(markdown.router)


@router.get("/ping")
def ping() -> dict:
    return {"pong": True}
