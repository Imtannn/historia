"""Sample seed data — Modern Europe demo set."""

from __future__ import annotations

from sqlmodel import Session, select

from app.models import Entity, EntityType, Link, RelationType, ReviewState


def seed_sample(session: Session) -> dict:
    """Load the brief's sample set. Idempotent-ish: skips if any entities exist."""
    existing = session.exec(select(Entity)).first()
    if existing:
        return {"ok": False, "reason": "database_not_empty", "created": 0}

    def add(
        type: EntityType,
        title: str,
        *,
        summary: str | None = None,
        body: str | None = None,
        date_start: str | None = None,
        date_end: str | None = None,
        parent_id: str | None = None,
        tags: list[str] | None = None,
    ) -> Entity:
        e = Entity(
            type=type,
            title=title,
            summary=summary,
            body=body,
            date_start=date_start,
            date_end=date_end,
            parent_id=parent_id,
            tags=tags or [],
        )
        session.add(e)
        session.flush()
        session.add(ReviewState(entity_id=e.id))
        return e

    def link(source: Entity, target: Entity, relation: RelationType) -> None:
        session.add(Link(source_id=source.id, target_id=target.id, relation=relation))

    # Places
    germany = add(EntityType.place, "Germany", summary="Central European country.", tags=["europe"])
    france = add(EntityType.place, "France", summary="Western European country.", tags=["europe"])
    italy = add(EntityType.place, "Italy", summary="Southern European peninsula.", tags=["europe"])
    rome = add(
        EntityType.place,
        "Rome",
        summary="Capital city; heart of the ancient Roman world.",
        parent_id=italy.id,
        tags=["europe", "city"],
    )
    belgium = add(
        EntityType.place,
        "Belgium",
        summary="Low Countries; site of Waterloo.",
        tags=["europe"],
    )

    # Figures
    napoleon = add(
        EntityType.figure,
        "Napoleon Bonaparte",
        summary="French military leader and emperor of the Napoleonic Era.",
        tags=["france", "military"],
    )
    caesar = add(
        EntityType.figure,
        "Julius Caesar",
        summary="Roman general and statesman of the late Republic.",
        tags=["rome"],
    )
    bismarck = add(
        EntityType.figure,
        "Otto von Bismarck",
        summary="Prussian statesman who engineered German unification.",
        tags=["germany"],
    )

    link(napoleon, france, RelationType.involves)
    link(caesar, rome, RelationType.involves)
    link(bismarck, germany, RelationType.involves)

    # Periods
    roman_rep = add(
        EntityType.period,
        "Roman Republic",
        summary="Era of republican Rome before the Empire.",
        date_start="-0509",
        date_end="-0027",
        tags=["rome"],
    )
    nap_era = add(
        EntityType.period,
        "Napoleonic Era",
        summary="Europe under the shadow of Napoleon's wars and reforms.",
        date_start="1799",
        date_end="1815",
        tags=["france", "europe"],
    )
    ger_uni = add(
        EntityType.period,
        "German Unification",
        summary="Process culminating in the German Empire.",
        date_start="1864",
        date_end="1871",
        tags=["germany"],
    )

    link(napoleon, nap_era, RelationType.related_to)
    link(caesar, roman_rep, RelationType.related_to)
    link(bismarck, ger_uni, RelationType.related_to)

    # Events
    waterloo = add(
        EntityType.event,
        "Battle of Waterloo",
        summary="Final defeat of Napoleon in 1815.",
        date_start="1815-06-18",
        tags=["napoleonic", "war"],
        body="Napoleon's last battle; coalition victory ended the Hundred Days.",
    )
    assassination = add(
        EntityType.event,
        "Assassination of Caesar",
        summary="Caesar killed on the Ides of March.",
        date_start="-0044-03-15",
        tags=["rome"],
        body="A conspiracy of senators ended Caesar's dictatorship.",
    )
    unification = add(
        EntityType.event,
        "Unification of Germany",
        summary="Proclamation of the German Empire at Versailles.",
        date_start="1871-01-18",
        tags=["germany"],
    )
    austerlitz = add(
        EntityType.event,
        "Battle of Austerlitz",
        summary="Napoleon's decisive victory in 1805.",
        date_start="1805-12-02",
        tags=["napoleonic", "war"],
    )

    link(waterloo, belgium, RelationType.occurred_in)
    link(waterloo, napoleon, RelationType.involves)
    link(waterloo, france, RelationType.related_to)
    link(assassination, rome, RelationType.occurred_in)
    link(assassination, caesar, RelationType.involves)
    link(unification, germany, RelationType.occurred_in)
    link(unification, bismarck, RelationType.involves)
    link(austerlitz, napoleon, RelationType.involves)
    link(austerlitz, france, RelationType.related_to)

    # Milestone part_of a period
    empire_proclaimed = add(
        EntityType.milestone,
        "German Empire proclaimed",
        summary="Wilhelm I declared Emperor at Versailles.",
        date_start="1871-01-18",
        parent_id=ger_uni.id,
        tags=["germany"],
    )
    link(empire_proclaimed, ger_uni, RelationType.part_of)
    link(empire_proclaimed, germany, RelationType.occurred_in)

    # Extra events for richer MCQ distractors
    trafalgar = add(
        EntityType.event,
        "Battle of Trafalgar",
        summary="Naval victory for Britain over France and Spain.",
        date_start="1805-10-21",
        tags=["napoleonic", "war"],
    )
    link(trafalgar, france, RelationType.related_to)

    # Timeline
    modern = add(
        EntityType.timeline,
        "Modern Europe",
        summary="Selected events spanning Rome to German unification.",
        tags=["europe"],
    )
    for ev in (assassination, austerlitz, trafalgar, waterloo, unification):
        link(modern, ev, RelationType.part_of)

    session.commit()
    count = len(session.exec(select(Entity)).all())
    return {"ok": True, "created": count}
