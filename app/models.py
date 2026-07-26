"""SQLModel data models for Historia."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from enum import Enum
from typing import Optional

from sqlalchemy import Column, JSON, Text
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_uuid() -> str:
    return str(uuid.uuid4())


class EntityType(str, Enum):
    event = "event"
    place = "place"
    figure = "figure"
    period = "period"
    milestone = "milestone"
    timeline = "timeline"
    topic = "topic"


class RelationType(str, Enum):
    occurred_in = "occurred_in"
    involves = "involves"
    part_of = "part_of"
    preceded_by = "preceded_by"
    related_to = "related_to"


# ---------- Entity ----------


class EntityBase(SQLModel):
    type: EntityType
    title: str = Field(min_length=1, max_length=500)
    summary: Optional[str] = Field(default=None, max_length=2000)
    body: Optional[str] = Field(default=None, sa_column=Column(Text))
    date_start: Optional[str] = Field(default=None, max_length=32)  # ISO date or year, e.g. -0044
    date_end: Optional[str] = Field(default=None, max_length=32)
    parent_id: Optional[str] = Field(default=None, foreign_key="entity.id", index=True)
    tags: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    place_name: Optional[str] = Field(default=None, max_length=500)
    place_url: Optional[str] = Field(default=None, max_length=2000)
    attachments: list[str] = Field(default_factory=list, sa_column=Column(JSON))


class Entity(EntityBase, table=True):
    id: str = Field(default_factory=new_uuid, primary_key=True)
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class EntityCreate(EntityBase):
    id: Optional[str] = None
    link_ids: list[str] = Field(default_factory=list)  # target entity ids for quick-add links
    link_relation: RelationType = RelationType.related_to


class EntityUpdate(SQLModel):
    type: Optional[EntityType] = None
    title: Optional[str] = Field(default=None, min_length=1, max_length=500)
    summary: Optional[str] = None
    body: Optional[str] = None
    date_start: Optional[str] = None
    date_end: Optional[str] = None
    parent_id: Optional[str] = None
    tags: Optional[list[str]] = None
    place_name: Optional[str] = None
    place_url: Optional[str] = None
    attachments: Optional[list[str]] = None


class EntityRead(EntityBase):
    id: str
    created_at: datetime
    updated_at: datetime


class TopicCreate(SQLModel):
    title: str = Field(min_length=1, max_length=500)
    event_ids: list[str] = Field(default_factory=list)


# ---------- Link ----------


class LinkBase(SQLModel):
    source_id: str = Field(foreign_key="entity.id", index=True)
    target_id: str = Field(foreign_key="entity.id", index=True)
    relation: RelationType = RelationType.related_to


class Link(LinkBase, table=True):
    id: str = Field(default_factory=new_uuid, primary_key=True)
    created_at: datetime = Field(default_factory=utcnow)


class LinkCreate(LinkBase):
    id: Optional[str] = None


class LinkRead(LinkBase):
    id: str
    created_at: datetime


# ---------- ReviewState ----------


class ReviewStateBase(SQLModel):
    times_seen: int = 0
    times_correct: int = 0
    last_reviewed_at: Optional[datetime] = None
    mastery: float = 0.0  # 0–100 running accuracy


class ReviewState(ReviewStateBase, table=True):
    entity_id: str = Field(primary_key=True, foreign_key="entity.id")


class ReviewStateRead(ReviewStateBase):
    entity_id: str


class ReviewResult(SQLModel):
    """Submitted after a flashcard or quiz item."""

    entity_id: str
    correct: bool
    xp_amount: int = 0


# ---------- Progress ----------


class ProgressBase(SQLModel):
    xp: int = 0
    streak_current: int = 0
    streak_longest: int = 0
    last_active_date: Optional[date] = None
    daily_goal_xp: int = 30
    xp_today: int = 0


class Progress(ProgressBase, table=True):
    id: int = Field(default=1, primary_key=True)


class ProgressRead(ProgressBase):
    id: int
    goal_hit_today: bool = False


class ProgressUpdate(SQLModel):
    daily_goal_xp: Optional[int] = Field(default=None, ge=1, le=1000)


# ---------- Export / Import ----------


class ExportPayload(SQLModel):
    version: int = 1
    exported_at: datetime
    entities: list[EntityRead]
    links: list[LinkRead]
    review_states: list[ReviewStateRead]
    progress: ProgressRead


class ImportOptions(SQLModel):
    mode: str = "merge"  # "merge" | "replace"
    payload: ExportPayload
