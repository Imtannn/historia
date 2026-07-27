"""FastAPI application entry."""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
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
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


def create_app() -> FastAPI:
    app = FastAPI(title="Historia", version="0.1.0", lifespan=lifespan)
    app.add_middleware(NoCacheStaticMiddleware)

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "app": "historia"}

    from app.api import router as api_router

    app.include_router(api_router, prefix="/api")

    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(TEMPLATES / "index.html")

    return app


app = create_app()
