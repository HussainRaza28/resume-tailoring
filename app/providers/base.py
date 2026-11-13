"""The interface every model provider implements.

A provider sends one request and streams back text. This base class turns that
text into a checked Pydantic object, so every provider returns the same thing:
data that matches the step's schema, or a ``ProviderError`` saying why not.
"""

from __future__ import annotations

import copy
import json
import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ValidationError

# Receives text as it streams in, for the live view in the interface.
DeltaSink = Callable[[str], None]


def ignore_deltas(_text: str) -> None:
    pass


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ProviderError(Exception):
    """Base class. ``kind`` is a short name for the UI; ``retryable`` says whether trying again may help."""

    kind = "other"
    retryable = False


class BadKey(ProviderError):
    kind = "bad_key"

    def __init__(self, detail: str = "") -> None:
        super().__init__("The API key was rejected. Check it in Settings.")
        self.detail = detail


class MissingKey(ProviderError):
    kind = "missing_key"

    def __init__(self) -> None:
        super().__init__("No API key is saved for this provider. Add one in Settings.")


class RateLimited(ProviderError):
    kind = "rate_limited"
    retryable = True

    def __init__(self, retry_after_s: float | None = None) -> None:
        super().__init__("Rate limited by the provider. Try again in a moment.")
        self.retry_after_s = retry_after_s


class Offline(ProviderError):
    kind = "offline"

    def __init__(self, message: str = "Could not reach the provider. Check your connection.") -> None:
        super().__init__(message)


class ServerError(ProviderError):
    kind = "server"
    retryable = True

    def __init__(self, detail: str = "") -> None:
        super().__init__("The provider is overloaded or returned a server error.")
        self.detail = detail


class BadOutput(ProviderError):
    kind = "bad_output"

    def __init__(self, detail: str) -> None:
        super().__init__(f"The model's reply did not match the expected format: {detail}")


class OtherError(ProviderError):
    kind = "other"


# ---------------------------------------------------------------------------
# Requests and replies
# ---------------------------------------------------------------------------


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0

    def add(self, other: Usage) -> None:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cache_write_tokens += other.cache_write_tokens


@dataclass
class CompletionRequest:
    # The pipeline step, such as "red_flags". Used in logs and by the Demo provider.
    step: str
    # Fixed instructions. Cached where the provider supports it.
    system: str
    # Large context that repeats across steps (the base resume). Also cached.
    context: str
    # The message for this step.
    user: str
    # The Pydantic model the reply must match.
    schema: type[BaseModel]
    max_tokens: int = 4096

    def json_schema(self) -> dict[str, Any]:
        return json_schema(self.schema)


@dataclass
class RawReply:
    """What a provider gets back before the base class checks it."""

    text: str
    usage: Usage = field(default_factory=Usage)
    # The model that answered, which can differ from the one asked for.
    model: str = ""


@dataclass
class Completion:
    data: BaseModel
    usage: Usage
    model: str
    duration_ms: int


def json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """The model's JSON Schema with every ``$ref`` written out in place.

    Pydantic puts nested models under ``$defs`` and points at them. Not every
    provider's structured-output mode follows those pointers, so they're inlined.
    """
    schema = model.model_json_schema()
    defs = schema.pop("$defs", {})

    def inline(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                name = node["$ref"].split("/")[-1]
                return inline(copy.deepcopy(defs[name]))
            return {k: inline(v) for k, v in node.items()}
        if isinstance(node, list):
            return [inline(v) for v in node]
        return node

    return inline(schema)


def parse_reply(text: str, schema: type[BaseModel]) -> BaseModel:
    """Check the reply text against the schema.

    A code fence around the JSON is tolerated, since local models sometimes add
    one even when asked for JSON only.
    """
    body = text.strip()
    if body.startswith("```"):
        body = body.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        return schema.model_validate_json(body)
    except ValidationError as e:
        start = body[:160]
        raise BadOutput(f"{e.error_count()} problem(s), first: {e.errors()[0]['msg']} (reply began: {start})") from e


def with_retries(call: Callable[[], Any], tries: int = 3, sleep: Callable[[float], None] = time.sleep) -> Any:
    """Run ``call``, retrying rate limits and server errors up to ``tries`` times in all.

    Waits for the provider's Retry-After when it gives one (capped at 30
    seconds), and otherwise 2, then 4 seconds.
    """
    for attempt in range(1, tries + 1):
        try:
            return call()
        except ProviderError as e:
            if not e.retryable or attempt == tries:
                raise
            wait = getattr(e, "retry_after_s", None)
            sleep(min(wait, 30) if wait is not None else 2**attempt)
    raise AssertionError("unreachable")


# ---------------------------------------------------------------------------
# The provider interface
# ---------------------------------------------------------------------------


class Provider(ABC):
    # Short id saved in settings, such as "claude_api".
    kind: str = ""
    # Name shown in the interface.
    label: str = ""

    def __init__(self, model: str) -> None:
        self.model = model

    def complete(self, request: CompletionRequest, on_delta: DeltaSink = ignore_deltas) -> Completion:
        """Send one request and return the checked reply."""
        start = time.monotonic()
        raw = with_retries(lambda: self._send(request, on_delta))
        data = parse_reply(raw.text, request.schema)
        return Completion(
            data=data,
            usage=raw.usage,
            model=raw.model or self.model,
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    @abstractmethod
    def _send(self, request: CompletionRequest, on_delta: DeltaSink) -> RawReply:
        """Send the request, pass streamed text to ``on_delta``, and return the full text."""


def to_json_text(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False)
