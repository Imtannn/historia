"""Launch Historia: start Uvicorn and open the browser."""

from __future__ import annotations

import threading
import time
import webbrowser

import uvicorn

HOST = "127.0.0.1"
PORT = 8765
URL = f"http://{HOST}:{PORT}"


def _open_browser() -> None:
    time.sleep(0.8)
    webbrowser.open(URL)


if __name__ == "__main__":
    threading.Thread(target=_open_browser, daemon=True).start()
    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=False)
