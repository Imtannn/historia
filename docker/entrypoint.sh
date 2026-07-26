#!/bin/sh
set -e
mkdir -p "${DATA_DIR:-/data}"
PORT="${PORT:-8000}"
exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
