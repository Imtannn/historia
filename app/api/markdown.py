"""Markdown rendering helper."""

from __future__ import annotations

import markdown
from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter(tags=["markdown"])


class MarkdownBody(BaseModel):
    text: str = Field(default="")


@router.post("/markdown")
def render_markdown(payload: MarkdownBody) -> dict:
    html = markdown.markdown(
        payload.text or "",
        extensions=["fenced_code", "tables", "nl2br", "sane_lists"],
    )
    return {"html": html}
