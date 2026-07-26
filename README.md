# Historia

Personal history notebook — organize knowledge (Notion-like) and learn it (Duolingo-like). Local-only: no login, no cloud, no API keys.

## Run

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

Opens http://127.0.0.1:8765 in your browser.

## Database

All data lives in `historia.db` at the project root (SQLite). Created automatically on first launch.

## Export / Import

- **Export:** Settings → Export, or `GET /api/export` — downloads a JSON dump of entities, links, review states, and progress.
- **Import:** Settings → Import — choose merge (default, upsert by id) or replace (wipe then load). Validate before writing.
- This JSON backup is the only safety net. Export regularly.

## Stack

Python 3.11+, FastAPI, SQLModel/SQLite, vanilla JS + Tailwind CDN. Offline after first load (fonts/Tailwind CDN cached by the browser).
