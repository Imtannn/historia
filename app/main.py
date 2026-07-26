"""FastAPI application entry."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.db import init_db

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
TEMPLATES = ROOT / "templates"


def create_app() -> FastAPI:
    app = FastAPI(title="Historia", version="0.1.0")

    @app.on_event("startup")
    def on_startup() -> None:
        init_db()

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "app": "historia"}

    # API routers registered in later commits; keep import soft for skeleton.
    from app.api import router as api_router

    app.include_router(api_router, prefix="/api")

    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(TEMPLATES / "index.html")

    return app


app = create_app()
