"""Media upload — images saved next to the database (persists on Railway /data)."""

from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.db import resolve_upload_dir

MAX_BYTES = 5 * 1024 * 1024
LEGACY_UPLOAD_DIR = Path(__file__).resolve().parent.parent / "static" / "uploads"


def _ext_from_bytes(data: bytes) -> str | None:
    """Detect image type from magic bytes — do not trust the client MIME type."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


def upload_dirs() -> list[Path]:
    primary = resolve_upload_dir()
    dirs = [primary]
    if LEGACY_UPLOAD_DIR.resolve() != primary.resolve() and LEGACY_UPLOAD_DIR.is_dir():
        dirs.append(LEGACY_UPLOAD_DIR)
    return dirs


def find_upload(name: str) -> Path | None:
    safe = Path(name).name
    if safe != name or not safe:
        return None
    for folder in upload_dirs():
        path = folder / safe
        if path.is_file():
            return path
    return None


router = APIRouter(tags=["upload"])


@router.post("/upload")
async def upload_media(file: UploadFile = File(...)) -> dict:
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Image too large (max 5 MB)")

    ext = _ext_from_bytes(data)
    if not ext:
        raise HTTPException(
            400,
            "That file is not a valid JPEG, PNG, GIF, or WebP image. "
            "Some apps paste PNG labels on non-PNG data — try Browse and pick the file.",
        )

    dest = resolve_upload_dir()
    dest.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ext}"
    (dest / name).write_bytes(data)
    return {"url": f"/static/uploads/{name}"}
