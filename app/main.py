"""FastAPI application entry."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from app.db import init_db

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
TEMPLATES = ROOT / "templates"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    """Keep JS/CSS fresh so module imports cannot mix old util.js with new modal.js."""

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        path = request.url.path
        if path.startswith("/static/js/") or path.startswith("/static/css/"):
            response.headers["Cache-Control"] = "no-store"
        elif path.startswith("/static/uploads/") and response.status_code >= 400:
            # Import restore writes files at the same URL; never keep a 404 in cache.
            response.headers["Cache-Control"] = "no-store"
        return response


def create_app() -> FastAPI:
    app = FastAPI(title="Historia", version="0.1.0", lifespan=lifespan)
    app.add_middleware(NoCacheStaticMiddleware)

    @app.get("/api/health")
    def health() -> dict:
        return {
            "status": "ok",
            "app": "historia",
            "version": 3,
            "features": {"classifications": True, "topic_reorder": True},
        }

    from app.api import router as api_router
    from app.api.upload import find_upload

    app.include_router(api_router, prefix="/api")

    @app.get("/static/uploads/{name}")
    def serve_upload(name: str) -> FileResponse:
        """Serve uploaded images from the data volume (and the legacy static folder)."""
        path = find_upload(name)
        if path is None:
            raise HTTPException(
                status_code=404,
                detail="Image not found",
                headers={"Cache-Control": "no-store"},
            )
        return FileResponse(path, headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(TEMPLATES / "index.html")

    return app


app = create_app()
