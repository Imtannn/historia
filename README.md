# Historia

Personal history notebook — organize **events** (date, notes, @links, tags, place, file links) and group them into **topics**. Learn side: flashcards & quizzes. No login or API keys.

## Run locally

```bash
npm run setup    # once: create .venv + install Python deps
npm run dev      # starts the app and opens the browser
```

Same as `python run.py` under the hood (FastAPI + Uvicorn). No frontend build — npm is only a launcher.

Or without npm:

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

Opens [http://127.0.0.1:8765](http://127.0.0.1:8765).

## Database

Locally: `historia.db` at the project root. On Railway: `/data/historia.db` (volume). Tables and a Progress row are created on first launch.

## Export / Import

JSON backup is the only safety net — treat it as first-class.

| Action | How |
|--------|-----|
| Export | Settings → **Export JSON**, or `GET /api/export` |
| Import | Settings → choose file → **Merge by id** (default) or **Replace all** |
| Wipe | Settings → Danger zone (double confirm) |
| Sample | Settings → **Load sample set** (empty DB only) |

## Deploy on Railway

Same pattern as Outreach: Dockerfile + `railway.toml`, SQLite on a volume at `/data`.

1. Push this repo to GitHub.
2. **Railway** → New project → Deploy from that repo (uses `Dockerfile` / `railway.toml`).
3. **Volume** → mount path `/data` (persist `historia.db`).
4. Env (image defaults already set):
   - `DATA_DIR=/data`
   - `SQLITE_PATH=/data/historia.db`
   - Railway sets `PORT` automatically
5. Generate a public domain (Settings → Networking → Generate domain).
6. Open `https://<service>.up.railway.app`.

Health check: `GET /api/health`.

CLI (from this folder, after `railway login`):

```bash
railway init          # or railway link
railway up
railway domain
```

## Features

- **Events** — short add form: flexible date + BC/AC, note, @ related events, tags, place URL, file links
- **Library board** — auto-sorted by date; multi-select → **Group into topic**
- **Topics** — named groups of events
- **Flashcards / Quiz** — generated from your events
- **XP, streaks, daily goal**

## Stack

Python 3.11+, FastAPI, Uvicorn, SQLModel/SQLite, vanilla JS + Tailwind CDN.
