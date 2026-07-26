# Historia

Personal history notebook — **organize** knowledge (Notion-like hubs) and **learn** it (Duolingo-like flashcards & quizzes). Local-only: no login, no cloud, no API keys.

## Run

```bash
python3.12 -m venv .venv          # 3.11+ required
source .venv/bin/activate         # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

Opens [http://127.0.0.1:8765](http://127.0.0.1:8765). One command after install: `python run.py`.

## Database

All data lives in `historia.db` at the project root (SQLite via SQLModel). Tables and a Progress row are created on first launch.

## Export / Import

JSON backup is the only safety net — treat it as first-class.

| Action | How |
|--------|-----|
| Export | Settings → **Export JSON**, or `GET /api/export` |
| Import | Settings → choose file → **Merge by id** (default) or **Replace all** |
| Wipe | Settings → Danger zone (double confirm) |
| Sample | Settings or Home empty state → **Load sample set** (empty DB only) |

Import validates links and review states before writing.

## Features

- **Library** — quick-add any entity type; search and filter by type/tag
- **Entity hubs** — grouped related entries + automatic backlinks
- **Timeline** — horizontal BCE-aware axis (undated items sort last, never crash)
- **Flashcards / Quiz** — template-generated from your notes (MCQ, type-in, match)
- **XP, streaks, daily goal** — encouraging progress; celebration when the goal is hit

## Project layout

```
app/
  models.py          # Entity, Link, ReviewState, Progress
  db.py              # SQLite engine + init
  dates.py           # Year-only / BCE helpers
  learn.py           # Flashcard & quiz generation
  progress_logic.py  # XP + streak rules
  seed.py            # Sample Modern Europe set
  api/               # FastAPI routers
  static/js/         # Vanilla ES-module SPA
  templates/         # index.html shell
run.py
historia.db          # created at runtime
```

## Stack

Python 3.11+, FastAPI, Uvicorn, SQLModel/SQLite, vanilla JS + Tailwind CDN. No npm build step. Works offline after first load (browser may cache CDN assets).

## Stretch (not in v1)

Graph neighborhood view, SM-2 spaced repetition (seam left via ReviewState), mastery charts, LLM smart-parse.
