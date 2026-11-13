"""A test-only HTTP front for the real Python bridge.

The desktop end-to-end test (ui/e2e/desktop.spec.ts) opens the built interface
from a file:// URL and stands in for pywebview by sending each `call` here.
Streamed events are collected and sent back with the reply, and the page
replays them. The app itself never runs a server; this exists only for tests.

    uv run python -m tests.bridge_server --port 4174
"""

from __future__ import annotations

import argparse
import json
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from app.bridge import Backend, Bridge
from app.core.db import Db
from app.core.secrets import MemoryStore

SAMPLE = Path(__file__).parent / "fixtures" / "sample_resume.tex"


def make_bridge() -> tuple[Bridge, dict[str, list[dict]]]:
    data_dir = Path(tempfile.mkdtemp(prefix="tailor-e2e-")) / "private"
    events: dict[str, list[dict]] = {}
    lock = threading.Lock()

    def emit(channel: str, event: dict) -> None:
        with lock:
            events.setdefault(channel, []).append(event)

    backend = Backend(data_dir, Db(":memory:"), MemoryStore(), emit=emit)
    bridge = Bridge(backend)
    bridge.call("import_base_resume", {"path": str(SAMPLE)})
    bridge.call("set_setting", {"key": "provider", "value": "demo"})
    bridge.call("set_setting", {"key": "export_dir", "value": str(data_dir.parent / "exports")})
    (data_dir.parent / "exports").mkdir()
    return bridge, events


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4174)
    port = parser.parse_args().port
    bridge, events = make_bridge()

    class Handler(BaseHTTPRequestHandler):
        def _headers(self, status: int) -> None:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-headers", "content-type")
            self.end_headers()

        def do_OPTIONS(self) -> None:
            self._headers(204)

        def do_GET(self) -> None:  # the test runner checks this to know the server is up
            self._headers(200)
            self.wfile.write(b"{}")

        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            reply = bridge.call(body["command"], body.get("args") or {})
            channel = (body.get("args") or {}).get("onEvent")
            sent = events.pop(channel, []) if channel else []
            self._headers(200)
            self.wfile.write(json.dumps({"reply": reply, "events": sent}).encode())

        def log_message(self, *_args) -> None:
            pass

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
