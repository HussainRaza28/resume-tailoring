"""A scripted provider for tests. It returns queued replies for each step."""

from __future__ import annotations

import json

from app.providers.base import CompletionRequest, DeltaSink, Provider, ProviderError, RawReply, Usage


class FakeProvider(Provider):
    kind = "fake"
    label = "Fake"

    def __init__(self) -> None:
        super().__init__("fake-1")
        self._replies: dict[str, list[dict | ProviderError]] = {}
        self.calls: list[CompletionRequest] = []

    def reply(self, step: str, data: dict) -> FakeProvider:
        """Queue a reply. Replies for a step come back in order, and the last one repeats."""
        self._replies.setdefault(step, []).append(data)
        return self

    def fail(self, step: str, error: ProviderError) -> FakeProvider:
        self._replies.setdefault(step, []).append(error)
        return self

    def call_count(self, step: str) -> int:
        return sum(1 for c in self.calls if c.step == step)

    def _send(self, request: CompletionRequest, on_delta: DeltaSink) -> RawReply:
        self.calls.append(request)
        queue = self._replies.get(request.step)
        if not queue:
            raise ProviderError(f"no fake reply for step {request.step}")
        nxt = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(nxt, ProviderError):
            raise nxt
        if request.schema.__name__ == "RewritesReply" and isinstance(nxt, dict) and "items" not in nxt:
            # Most scripted rewrite replies only care about the lines; an empty report is a valid answer.
            nxt = {**nxt, "items": []}
        text = json.dumps(nxt)
        on_delta(text)
        return RawReply(text=text, usage=Usage(input_tokens=len(request.user) // 4, output_tokens=len(text) // 4))
