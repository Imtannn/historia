"""Launch Historia: start Uvicorn and open the browser."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser

import uvicorn

HOST = "127.0.0.1"
PORT = int(os.getenv("HISTORIA_PORT", "8765"))


def _pids_on_port(port: int) -> list[int]:
    try:
        out = subprocess.check_output(
            ["lsof", "-ti", f":{port}"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    return [int(p) for p in out.split() if p.strip().isdigit()]


def _stop_stale_servers() -> None:
    """Kill any Historia dev servers on our port range so only one instance runs."""
    my_pid = os.getpid()
    killed: list[tuple[int, int]] = []
    for port in range(8765, 8771):
        for pid in _pids_on_port(port):
            if pid == my_pid:
                continue
            try:
                os.kill(pid, 9)
                killed.append((pid, port))
            except OSError as err:
                print(f"Could not stop PID {pid} on port {port}: {err}", file=sys.stderr)
    if killed:
        detail = ", ".join(f"{pid} (:{port})" for pid, port in killed)
        print(f"Stopped old server(s): {detail}")
        time.sleep(0.5)
    else:
        print("No old servers on ports 8765–8770.")


def _bind_port(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((HOST, port))


def _open_browser(url: str) -> None:
    time.sleep(0.8)
    webbrowser.open(url)


if __name__ == "__main__":
    _stop_stale_servers()
    try:
        _bind_port(PORT)
    except OSError:
        print(
            f"Could not bind to {HOST}:{PORT}. "
            f"Try: lsof -ti :{PORT} | xargs kill -9",
            file=sys.stderr,
        )
        raise SystemExit(1)

    url = f"http://{HOST}:{PORT}"
    print(f"Historia running at {url}")
    threading.Thread(target=_open_browser, args=(url,), daemon=True).start()
    uvicorn.run("app.main:app", host=HOST, port=PORT, reload=False)
