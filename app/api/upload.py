"""Media upload — images saved under static/uploads."""

from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

ROOT = Path(__file__).resolve().parent.parent
UPLOAD_DIR = ROOT / "static" / "uploads"
MAX_BYTES = 5 * 1024 * 1024
ALLOWED = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


def _ext_from_bytes(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


router = APIRouter(tags=["upload"])


@router.post("/upload")
async def upload_media(file: UploadFile = File(...)) -> dict:
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Image too large (max 5 MB)")

    content_type = (file.content_type or "").lower()
    ext = ALLOWED.get(content_type) or _ext_from_bytes(data)
    if not ext:
        raise HTTPException(400, "Only JPEG, PNG, GIF, and WebP images are supported")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ext}"
    (UPLOAD_DIR / name).write_bytes(data)
    return {"url": f"/static/uploads/{name}"}
