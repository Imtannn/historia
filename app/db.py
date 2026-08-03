"""Database engine, session, and initialization."""

from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import text
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import Progress

ROOT = Path(__file__).resolve().parent.parent


def resolve_db_path() -> Path:
    """Local: project-root historia.db. Railway: SQLITE_PATH or DATA_DIR/historia.db."""
    explicit = os.getenv("SQLITE_PATH", "").strip()
    if explicit:
        path = Path(explicit)
    else:
        data_dir = os.getenv("DATA_DIR", "").strip()
        if data_dir:
            path = Path(data_dir) / "historia.db"
        else:
            path = ROOT / "historia.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


DB_PATH = resolve_db_path()
DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False},
)

# Columns added after the initial schema — migrate safely on startup.
_ENTITY_EXTRA_COLUMNS = {
    "place_name": "ALTER TABLE entity ADD COLUMN place_name VARCHAR(500)",
    "place_url": "ALTER TABLE entity ADD COLUMN place_url VARCHAR(2000)",
    "attachments": "ALTER TABLE entity ADD COLUMN attachments JSON",
    "reign_start": "ALTER TABLE entity ADD COLUMN reign_start VARCHAR(32)",
    "reign_end": "ALTER TABLE entity ADD COLUMN reign_end VARCHAR(32)",
    "country_name": "ALTER TABLE entity ADD COLUMN country_name VARCHAR(500)",
    "country_names": "ALTER TABLE entity ADD COLUMN country_names JSON",
    "category": "ALTER TABLE entity ADD COLUMN category VARCHAR(64)",
}

_LINK_EXTRA_COLUMNS = {
    "role": "ALTER TABLE link ADD COLUMN role VARCHAR(32)",
    "sort_order": "ALTER TABLE link ADD COLUMN sort_order INTEGER DEFAULT 0",
}

_PROGRESS_EXTRA_COLUMNS = {
    "categories": "ALTER TABLE progress ADD COLUMN categories JSON",
}


def _migrate_table_columns(table: str, columns: dict[str, str]) -> None:
    with engine.connect() as conn:
        rows = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
        if not rows:
            return
        existing = {row[1] for row in rows}
        for name, ddl in columns.items():
            if name not in existing:
                conn.execute(text(ddl))
        conn.commit()


def init_db() -> None:
    """Create tables, migrate columns, and ensure a single Progress row exists."""
    SQLModel.metadata.create_all(engine)
    _migrate_table_columns("entity", _ENTITY_EXTRA_COLUMNS)
    _migrate_table_columns("link", _LINK_EXTRA_COLUMNS)
    _migrate_table_columns("progress", _PROGRESS_EXTRA_COLUMNS)
    with Session(engine) as session:
        existing = session.get(Progress, 1)
        if existing is None:
            session.add(Progress(id=1))
        elif existing.categories is None:
            existing.categories = []
            session.add(existing)
        session.commit()


def get_session():
    with Session(engine) as session:
        yield session


def wipe_all(session: Session) -> None:
    """Delete all rows and re-seed the Progress row."""
    from app.models import Entity, Link, ReviewState

    for model in (Link, ReviewState, Entity, Progress):
        for row in session.exec(select(model)).all():
            session.delete(row)
    session.add(Progress(id=1))
    session.commit()
