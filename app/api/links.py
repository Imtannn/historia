"""Link CRUD endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.api.roles import ROLE_LINK_RELATIONS, http_normalize_role
from app.db import get_session
from app.models import Entity, EntityType, Link, LinkCreate, LinkRead, LinkUpdate, RelationType

router = APIRouter(prefix="/links", tags=["links"])


@router.get("", response_model=list[LinkRead])
def list_links(
    entity_id: str | None = None,
    session: Session = Depends(get_session),
) -> list[LinkRead]:
    stmt = select(Link)
    if entity_id:
        stmt = stmt.where((Link.source_id == entity_id) | (Link.target_id == entity_id))
    rows = session.exec(stmt).all()
    return [LinkRead.model_validate(r) for r in rows]


@router.post("", response_model=LinkRead, status_code=201)
def create_link(payload: LinkCreate, session: Session = Depends(get_session)) -> LinkRead:
    if payload.source_id == payload.target_id:
        raise HTTPException(400, "Cannot link an entity to itself")
    if not session.get(Entity, payload.source_id):
        raise HTTPException(404, "Source entity not found")
    if not session.get(Entity, payload.target_id):
        raise HTTPException(404, "Target entity not found")

    role = None
    if payload.relation in ROLE_LINK_RELATIONS and payload.role:
        role = http_normalize_role(payload.role, payload.relation)

    existing = session.exec(
        select(Link).where(
            Link.source_id == payload.source_id,
            Link.target_id == payload.target_id,
            Link.relation == payload.relation,
        )
    ).first()
    if existing:
        if role is not None and existing.role != role:
            existing.role = role
            session.add(existing)
            session.commit()
            session.refresh(existing)
        return LinkRead.model_validate(existing)

    link = Link(
        source_id=payload.source_id,
        target_id=payload.target_id,
        relation=payload.relation,
        role=role,
    )
    source = session.get(Entity, payload.source_id)
    target = session.get(Entity, payload.target_id)
    if (
        source
        and target
        and source.type == EntityType.topic
        and payload.relation == RelationType.part_of
    ):
        existing = session.exec(
            select(Link).where(
                Link.source_id == payload.source_id,
                Link.relation == RelationType.part_of,
            )
        ).all()
        max_order = -1
        for row in existing:
            member = session.get(Entity, row.target_id)
            if member and member.type == target.type:
                max_order = max(max_order, int(getattr(row, "sort_order", 0) or 0))
        link.sort_order = max_order + 1
    if payload.id:
        link.id = payload.id
    session.add(link)
    session.commit()
    session.refresh(link)
    return LinkRead.model_validate(link)


@router.patch("/{link_id}", response_model=LinkRead)
def update_link(
    link_id: str,
    payload: LinkUpdate,
    session: Session = Depends(get_session),
) -> LinkRead:
    link = session.get(Link, link_id)
    if not link:
        raise HTTPException(404, "Link not found")
    if "role" in payload.model_dump(exclude_unset=True):
        if link.relation not in ROLE_LINK_RELATIONS and payload.role:
            raise HTTPException(400, "Roles are only for involves or related_to links")
        link.role = http_normalize_role(payload.role, link.relation)
        session.add(link)
        session.commit()
        session.refresh(link)
    if payload.sort_order is not None:
        link.sort_order = payload.sort_order
        session.add(link)
        session.commit()
        session.refresh(link)
    return LinkRead.model_validate(link)


@router.delete("/{link_id}", status_code=204)
def delete_link(link_id: str, session: Session = Depends(get_session)) -> None:
    link = session.get(Link, link_id)
    if not link:
        raise HTTPException(404, "Link not found")
    session.delete(link)
    session.commit()
