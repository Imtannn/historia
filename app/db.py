"""Database engine, session, and initialization."""

from __future__ import annotations

from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine, select

from app.models import Progress

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "historia.db"
DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False},
)


def init_db() -> None:
    """Create tables and ensure a single Progress row exists."""
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        existing = session.get(Progress, 1)
        if existing is None:
            session.add(Progress(id=1))
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
