"""Ollama, running on this computer. Nothing leaves the machine.

Calls ``/api/chat`` with ``format`` set to the step's JSON schema. Ollama
streams its reply as one JSON object per line.
"""

from __future__ import annotations

import json

import httpx2

from app.providers.base import (
    BadOutput,
    CompletionRequest,
    DeltaSink,
    Offline,
    OtherError,
    Provider,
    RawReply,
    ServerError,
    Usage,
)

DEFAULT_HOST = "http://127.0.0.1:11434"
NOT_RUNNING = "Ollama is not running. Start the Ollama app, then try again."
# Local models answer slowly, so the read timeout is generous.
TIMEOUT = httpx2.Timeout(600.0, connect=5.0)
# Ollama's default context is small. The resume, posting and instructions need more.
CONTEXT_TOKENS = 16384


class OllamaProvider(Provider):
    kind = "ollama"
    label = "Ollama"

    def __init__(self, model: str, host: str = DEFAULT_HOST) -> None:
        super().__init__(model)
        self.host = host.rstrip("/")

    def _body(self, request: CompletionRequest) -> dict:
        return {
            "model": self.model,
            "stream": True,
            "format": request.json_schema(),
            "messages": [
                {"role": "system", "content": f"{request.system}\n\n{request.context}\n\nReply with JSON only."},
                {"role": "user", "content": request.user},
            ],
            "options": {"num_ctx": CONTEXT_TOKENS},
        }

    def _send(self, request: CompletionRequest, on_delta: DeltaSink) -> RawReply:
        text = []
        usage = Usage()
        try:
            with httpx2.stream("POST", f"{self.host}/api/chat", json=self._body(request), timeout=TIMEOUT) as resp:
                if resp.status_code == 404:
                    raise OtherError(
                        f"Ollama has no model named {self.model}. Pull it with "
                        f"`ollama pull {self.model}` or pick another in Settings."
                    )
                if resp.status_code >= 500:
                    raise ServerError(resp.read().decode(errors="replace"))
                if resp.status_code != 200:
                    raise OtherError(f"Ollama returned HTTP {resp.status_code}: {resp.read().decode(errors='replace')}")
                for line in resp.iter_lines():
                    if not line.strip():
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError as e:
                        raise BadOutput(f"bad stream line from Ollama: {e}") from e
                    if "error" in event:
                        raise OtherError(event["error"])
                    piece = event.get("message", {}).get("content", "")
                    if piece:
                        text.append(piece)
                        on_delta(piece)
                    if event.get("done"):
                        usage = Usage(
                            input_tokens=event.get("prompt_eval_count", 0),
                            output_tokens=event.get("eval_count", 0),
                        )
        except httpx2.TransportError as e:
            raise Offline(NOT_RUNNING) from e
        return RawReply(text="".join(text), usage=usage, model=self.model)

    def list_models(self) -> list[dict]:
        """Models pulled into Ollama, as {"name", "size_bytes"}, for the picker in Settings."""
        try:
            resp = httpx2.get(f"{self.host}/api/tags", timeout=10.0)
        except httpx2.TransportError as e:
            raise Offline(NOT_RUNNING) from e
        if resp.status_code != 200:
            raise OtherError(f"Ollama returned HTTP {resp.status_code}")
        return [{"name": m["name"], "size_bytes": m.get("size", 0)} for m in resp.json().get("models", [])]
