"""Deterministic flashcard & quiz generation from entities (no LLM)."""

from __future__ import annotations

import hashlib
import random
import re
from typing import Any, Optional

from sqlmodel import Session, select

from app.dates import format_display_date
from app.models import Entity, EntityType, Link, RelationType, ReviewState
from app.progress_logic import XP_FLASHCARD, XP_MATCH, XP_MCQ, XP_TYPEIN


def _rng(*parts: str) -> random.Random:
    """Deterministic RNG from stable seeds so sessions are reproducible."""
    h = hashlib.sha256("|".join(parts).encode()).hexdigest()
    return random.Random(int(h[:16], 16))


def _filter_entities(
    session: Session,
    *,
    type: Optional[str] = None,
    tag: Optional[str] = None,
    place_id: Optional[str] = None,
) -> list[Entity]:
    rows = list(session.exec(select(Entity)).all())
    if type:
        rows = [e for e in rows if e.type.value == type]
    if tag:
        tl = tag.lower()
        rows = [e for e in rows if any(t.lower() == tl for t in (e.tags or []))]
    if place_id:
        # Entities linked to this place (either direction) or children
        link_ids: set[str] = set()
        for link in session.exec(
            select(Link).where((Link.source_id == place_id) | (Link.target_id == place_id))
        ).all():
            link_ids.add(link.target_id if link.source_id == place_id else link.source_id)
        children = session.exec(select(Entity).where(Entity.parent_id == place_id)).all()
        for c in children:
            link_ids.add(c.id)
        rows = [e for e in rows if e.id in link_ids or e.id == place_id]
    return rows


def _linked(
    session: Session,
    entity_id: str,
    relation: Optional[RelationType] = None,
    target_type: Optional[EntityType] = None,
) -> list[Entity]:
    links = session.exec(
        select(Link).where((Link.source_id == entity_id) | (Link.target_id == entity_id))
    ).all()
    out: list[Entity] = []
    for link in links:
        if relation and link.relation != relation:
            continue
        other_id = link.target_id if link.source_id == entity_id else link.source_id
        other = session.get(Entity, other_id)
        if not other:
            continue
        if target_type and other.type != target_type:
            continue
        out.append(other)
    return out


def _first_linked(
    session: Session,
    entity: Entity,
    relation: Optional[RelationType] = None,
    target_type: Optional[EntityType] = None,
) -> Optional[Entity]:
    linked = _linked(session, entity.id, relation, target_type)
    return linked[0] if linked else None


# ---------- Flashcards ----------


def generate_flashcard(session: Session, entity: Entity) -> Optional[dict[str, Any]]:
    """Template-based card; returns None if entity can't form a useful card."""
    t = entity.type

    if t == EntityType.event:
        if entity.date_start:
            return {
                "entity_id": entity.id,
                "prompt": f"When did {entity.title} happen?",
                "answer": format_display_date(entity.date_start)
                + (f" – {format_display_date(entity.date_end)}" if entity.date_end else ""),
                "kind": "when",
                "xp": XP_FLASHCARD,
            }
        if entity.place_name:
            return {
                "entity_id": entity.id,
                "prompt": f"Where did {entity.title} occur?",
                "answer": entity.place_name,
                "kind": "where",
                "xp": XP_FLASHCARD,
            }
        place = _first_linked(session, entity, RelationType.occurred_in, EntityType.place)
        if place:
            return {
                "entity_id": entity.id,
                "prompt": f"Where did {entity.title} occur?",
                "answer": place.title,
                "kind": "where",
                "xp": XP_FLASHCARD,
            }
        if entity.summary:
            return {
                "entity_id": entity.id,
                "prompt": f"What was {entity.title}?",
                "answer": entity.summary,
                "kind": "what",
                "xp": XP_FLASHCARD,
            }

    if t == EntityType.topic:
        return None

    if t == EntityType.figure:
        place = _first_linked(session, entity, RelationType.involves, EntityType.place)
        if place:
            return {
                "entity_id": entity.id,
                "prompt": f"Which place is most associated with {entity.title}?",
                "answer": place.title,
                "kind": "who-where",
                "xp": XP_FLASHCARD,
            }
        return {
            "entity_id": entity.id,
            "prompt": f"Who was {entity.title}?",
            "answer": entity.summary or entity.title,
            "kind": "who",
            "xp": XP_FLASHCARD,
        }

    if t == EntityType.place:
        return {
            "entity_id": entity.id,
            "prompt": f"What do you know about {entity.title}?",
            "answer": entity.summary or entity.title,
            "kind": "place",
            "xp": XP_FLASHCARD,
        }

    if t == EntityType.period:
        if entity.date_start or entity.date_end:
            rng = " – ".join(
                filter(
                    None,
                    [format_display_date(entity.date_start), format_display_date(entity.date_end)],
                )
            )
            return {
                "entity_id": entity.id,
                "prompt": f"When was the {entity.title}?",
                "answer": rng or entity.summary or entity.title,
                "kind": "period-when",
                "xp": XP_FLASHCARD,
            }
        return {
            "entity_id": entity.id,
            "prompt": f"What was the {entity.title}?",
            "answer": entity.summary or entity.title,
            "kind": "period",
            "xp": XP_FLASHCARD,
        }

    if t == EntityType.milestone:
        period = entity.parent_id and session.get(Entity, entity.parent_id)
        if not period:
            period = _first_linked(session, entity, RelationType.part_of, EntityType.period)
        answer_bits = []
        if entity.date_start:
            answer_bits.append(format_display_date(entity.date_start))
        if period:
            answer_bits.append(f"part of {period.title}")
        if entity.summary:
            answer_bits.append(entity.summary)
        return {
            "entity_id": entity.id,
            "prompt": f"What is the moment “{entity.title}”?",
            "answer": "; ".join(answer_bits) or entity.title,
            "kind": "milestone",
            "xp": XP_FLASHCARD,
        }

    return None


def list_flashcards(
    session: Session,
    *,
    type: Optional[str] = None,
    tag: Optional[str] = None,
    place_id: Optional[str] = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    entities = _filter_entities(session, type=type, tag=tag, place_id=place_id)
    # Event-first: skip topics (and prefer events when unfiltered)
    entities = [e for e in entities if e.type != EntityType.topic]
    if type is None:
        events = [e for e in entities if e.type == EntityType.event]
        if events:
            entities = events
    # Prefer lower mastery
    mastery = {
        r.entity_id: r.mastery
        for r in session.exec(select(ReviewState)).all()
    }
    entities.sort(key=lambda e: (mastery.get(e.id, 0.0), e.title.lower()))
    cards = []
    for e in entities:
        card = generate_flashcard(session, e)
        if card:
            cards.append(card)
        if len(cards) >= limit:
            break
    return cards


# ---------- Quiz ----------


def normalize_answer(text: str) -> str:
    s = (text or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    if s.startswith("the "):
        s = s[4:]
    # strip punctuation
    s = re.sub(r"[^\w\s-]", "", s)
    return s.strip()


def answers_match(user: str, expected: str) -> bool:
    a = normalize_answer(user)
    b = normalize_answer(expected)
    if not a or not b:
        return False
    if a == b:
        return True
    # close: one contains the other (min length 3)
    if len(a) >= 3 and len(b) >= 3 and (a in b or b in a):
        return True
    return False


def _mcq_for_entity(session: Session, entity: Entity, pool: list[Entity], rng: random.Random) -> Optional[dict]:
    card = generate_flashcard(session, entity)
    if not card:
        return None
    correct = card["answer"]
    # Distractors: answers from same-type flashcards
    same = [e for e in pool if e.id != entity.id and e.type == entity.type]
    distractors: list[str] = []
    rng.shuffle(same)
    for other in same:
        oc = generate_flashcard(session, other)
        if not oc:
            continue
        ans = oc["answer"]
        if normalize_answer(ans) == normalize_answer(correct):
            continue
        if ans not in distractors:
            distractors.append(ans)
        if len(distractors) >= 3:
            break
    if len(distractors) < 3:
        return None
    options = distractors[:3] + [correct]
    rng.shuffle(options)
    return {
        "type": "mcq",
        "entity_id": entity.id,
        "prompt": card["prompt"],
        "options": options,
        "answer": correct,
        "xp": XP_MCQ,
    }


def _typein_for_entity(session: Session, entity: Entity) -> Optional[dict]:
    if entity.type == EntityType.event and entity.date_start:
        return {
            "type": "typein",
            "entity_id": entity.id,
            "prompt": f"In what year did {entity.title} happen?",
            "answer": format_display_date(entity.date_start),
            "hint": "Year or BCE year",
            "xp": XP_TYPEIN,
        }
    if entity.type == EntityType.figure:
        place = _first_linked(session, entity, RelationType.involves, EntityType.place)
        if place:
            return {
                "type": "typein",
                "entity_id": entity.id,
                "prompt": f"Name a place associated with {entity.title}.",
                "answer": place.title,
                "hint": "Place name",
                "xp": XP_TYPEIN,
            }
    if entity.type == EntityType.event:
        if entity.place_name:
            return {
                "type": "typein",
                "entity_id": entity.id,
                "prompt": f"Where did {entity.title} take place?",
                "answer": entity.place_name,
                "hint": "Place name",
                "xp": XP_TYPEIN,
            }
        place = _first_linked(session, entity, RelationType.occurred_in, EntityType.place)
        if place:
            return {
                "type": "typein",
                "entity_id": entity.id,
                "prompt": f"Where did {entity.title} take place?",
                "answer": place.title,
                "hint": "Place name",
                "xp": XP_TYPEIN,
            }
    return None


def _match_set(session: Session, pool: list[Entity], rng: random.Random, n: int = 4) -> Optional[dict]:
    """Match events → place_name (or linked places)."""
    pairs: list[tuple[str, str, str]] = []  # prompt, answer, entity_id

    events = [e for e in pool if e.type == EntityType.event]
    rng.shuffle(events)
    for e in events:
        if e.place_name:
            pairs.append((e.title, e.place_name, e.id))
        else:
            place = _first_linked(session, e, RelationType.occurred_in, EntityType.place)
            if place:
                pairs.append((e.title, place.title, e.id))
        if len(pairs) >= n:
            break

    if len(pairs) < 3:
        pairs = []
        figures = [e for e in pool if e.type == EntityType.figure]
        rng.shuffle(figures)
        for e in figures:
            place = _first_linked(session, e, RelationType.involves, EntityType.place)
            if place:
                pairs.append((e.title, place.title, e.id))
            if len(pairs) >= n:
                break

    if len(pairs) < 3:
        return None

    pairs = pairs[:n]
    prompts = [{"id": p[2], "label": p[0]} for p in pairs]
    answers = [{"id": p[2], "label": p[1]} for p in pairs]
    rng.shuffle(answers)
    return {
        "type": "match",
        "entity_id": pairs[0][2],
        "entity_ids": [p[2] for p in pairs],
        "prompt": "Match each item to its place",
        "left": prompts,
        "right": answers,
        "pairs": {p[2]: p[1] for p in pairs},
        "xp": XP_MATCH,
    }


def build_quiz_session(
    session: Session,
    *,
    length: int = 10,
    quiz_type: str = "mixed",  # mcq | typein | match | mixed
    type: Optional[str] = None,
    tag: Optional[str] = None,
    place_id: Optional[str] = None,
    seed: Optional[str] = None,
) -> dict:
    length = max(1, min(length, 50))
    pool = _filter_entities(session, type=type, tag=tag, place_id=place_id)
    seed = seed or f"{length}:{quiz_type}:{type}:{tag}:{place_id}:{len(pool)}"
    rng = _rng(seed)

    questions: list[dict] = []
    candidates = pool[:]
    rng.shuffle(candidates)

    if quiz_type == "match":
        match = _match_set(session, pool, rng, n=min(4, max(3, length)))
        if match:
            questions.append(match)
        return {"questions": questions, "length": len(questions), "seed": seed}

    for entity in candidates:
        if len(questions) >= length:
            break
        q = None
        if quiz_type == "mcq":
            q = _mcq_for_entity(session, entity, pool, rng)
        elif quiz_type == "typein":
            q = _typein_for_entity(session, entity)
        else:  # mixed — rotate
            kinds = ["mcq", "typein"]
            kind = kinds[len(questions) % len(kinds)]
            if kind == "mcq":
                q = _mcq_for_entity(session, entity, pool, rng)
            else:
                q = _typein_for_entity(session, entity)
            if q is None:
                q = _mcq_for_entity(session, entity, pool, rng) or _typein_for_entity(session, entity)

        if q:
            questions.append(q)

    # Optionally append one match set at end for mixed if room conceptually
    if quiz_type == "mixed" and len(questions) < length:
        match = _match_set(session, pool, rng)
        if match:
            questions.append(match)

    return {"questions": questions, "length": len(questions), "seed": seed}
