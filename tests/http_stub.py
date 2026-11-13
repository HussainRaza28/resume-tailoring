"""A tiny local HTTP server for provider tests.

It answers each request with the next canned reply and records what it was
sent, so a provider's real HTTP and streaming code can run without a network.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Stub:
    def __init__(self, replies: list[tuple[int, str, str]]):
        # Each reply is (status, content type, body).
        self.replies = list(replies)
        self.requests: list[dict] = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length).decode() if length else ""
                stub.requests.append(
                    {"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}
                )
                status, ctype, text = stub.replies.pop(0) if len(stub.replies) > 1 else stub.replies[0]
                data = text.encode()
                self.send_response(status)
                self.send_header("content-type", ctype)
                self.send_header("content-length", str(len(data)))
                self.send_header("retry-after", "2")
                self.end_headers()
                self.wfile.write(data)

            do_GET = _answer
            do_POST = _answer

            def log_message(self, *_args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()

    def body_json(self, index: int = -1) -> dict:
        return json.loads(self.requests[index]["body"])

    def close(self) -> None:
        self.server.shutdown()


def sse(events: list[tuple[str, dict]]) -> str:
    """Write events in server-sent-event format."""
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events)
