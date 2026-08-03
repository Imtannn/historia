"""API package — routers assembled here."""

from fastapi import APIRouter

from app.api import backup, catalog, entities, learn, links, markdown, progress, seed, timeline, topics, upload

router = APIRouter()
router.include_router(entities.router)
router.include_router(links.router)
router.include_router(backup.router)
router.include_router(markdown.router)
router.include_router(timeline.router)
router.include_router(progress.router)
router.include_router(learn.router)
router.include_router(seed.router)
router.include_router(topics.router)
router.include_router(catalog.router)
router.include_router(upload.router)


@router.get("/ping")
def ping() -> dict:
    return {"pong": True}
