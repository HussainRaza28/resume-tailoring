"""Tests for the Claude API provider against a local stand-in for the API."""

import json

import pytest

from tests.sample_schema import SampleReply
from app.providers.base import BadKey, BadOutput, CompletionRequest, MissingKey, OtherError, RateLimited
from app.providers.claude_api import DEFAULT_MODEL, FALLBACK_BETA, ClaudeApiProvider
from tests.http_stub import Stub, sse

REPLY = {"company": "Larkspur Freight", "role": "Platform Intern", "red_flags": []}


def message_stream(text: str, stop_reason: str = "end_turn") -> str:
    half = len(text) // 2
    return sse([
        ("message_start", {"type": "message_start", "message": {
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5",
            "content": [], "stop_reason": None, "stop_sequence": None,
            "usage": {"input_tokens": 40, "output_tokens": 1,
                      "cache_read_input_tokens": 900, "cache_creation_input_tokens": 0}}}),
        ("content_block_start", {"type": "content_block_start", "index": 0,
                                 "content_block": {"type": "text", "text": ""}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0,
                                 "delta": {"type": "text_delta", "text": text[:half]}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0,
                                 "delta": {"type": "text_delta", "text": text[half:]}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None},
                           "usage": {"output_tokens": 25}}),
        ("message_stop", {"type": "message_stop"}),
    ])


def error_body(kind: str, message: str) -> str:
    return json.dumps({"type": "error", "error": {"type": kind, "message": message}})


@pytest.fixture
def stub_factory():
    stubs = []

    def make(replies):
        stub = Stub(replies)
        stubs.append(stub)
        return stub

    yield make
    for s in stubs:
        s.close()


def request():
    return CompletionRequest(
        step="diagnose", system="Rules.", context="The resume.", user="The posting.", schema=SampleReply
    )


def provider(stub, **kw):
    return ClaudeApiProvider("sk-ant-test", base_url=stub.url, **kw)


def test_streams_and_returns_checked_data(stub_factory):
    stub = stub_factory([(200, "text/event-stream", message_stream(json.dumps(REPLY)))])
    seen = []
    out = provider(stub).complete(request(), seen.append)
    assert out.data == SampleReply(**REPLY)
    assert len(seen) == 2 and "".join(seen) == json.dumps(REPLY)
    assert out.usage.cache_read_tokens == 900
    assert out.usage.output_tokens == 25
    assert out.model == "claude-sonnet-5-5"


def test_request_caches_the_resume_and_asks_for_the_schema(stub_factory):
    stub = stub_factory([(200, "text/event-stream", message_stream(json.dumps(REPLY)))])
    provider(stub, effort="low").complete(request())
    body = stub.body_json()
    assert body["model"] == DEFAULT_MODEL
    assert body["system"][0] == {"type": "text", "text": "Rules."}
    assert body["system"][1]["cache_control"] == {"type": "ephemeral"}
    assert body["messages"] == [{"role": "user", "content": "The posting."}]
    fmt = body["output_config"]["format"]
    assert fmt["type"] == "json_schema" and fmt["schema"]["additionalProperties"] is False
    assert body["output_config"]["effort"] == "low"
    assert body["fallbacks"] == "default"
    assert FALLBACK_BETA in stub.requests[-1]["headers"]["anthropic-beta"]
    assert stub.requests[-1]["headers"]["authorization"] == "Bearer sk-ant-test"


def test_retries_without_fallbacks_when_the_account_rejects_them(stub_factory):
    stub = stub_factory([
        (400, "application/json", error_body("invalid_request_error", "fallbacks: not available for this account")),
        (200, "text/event-stream", message_stream(json.dumps(REPLY))),
    ])
    p = provider(stub)
    assert p.complete(request()).data.company == "Larkspur Freight"
    assert "fallbacks" not in stub.body_json(-1)
    assert p.use_fallbacks is False


def test_errors_are_mapped(stub_factory):
    stub = stub_factory([(401, "application/json", error_body("authentication_error", "invalid x-api-key"))])
    with pytest.raises(BadKey):
        provider(stub).complete(request())
    stub = stub_factory([(400, "application/json", error_body("invalid_request_error", "bad schema"))])
    with pytest.raises(OtherError, match="bad schema"):
        provider(stub).complete(request())


def test_rate_limit_is_retried_then_reported(stub_factory, monkeypatch):
    monkeypatch.setattr("app.providers.base.time.sleep", lambda _s: None)
    stub = stub_factory([(429, "application/json", error_body("rate_limit_error", "slow down"))])
    with pytest.raises(RateLimited) as err:
        provider(stub).complete(request())
    assert err.value.retry_after_s == 2
    assert len(stub.requests) == 3


def test_refusal_and_cut_off_replies_are_errors(stub_factory):
    stub = stub_factory([(200, "text/event-stream", message_stream("", stop_reason="refusal"))])
    with pytest.raises(BadOutput, match="declined"):
        provider(stub).complete(request())
    stub = stub_factory([(200, "text/event-stream", message_stream('{"company": "', stop_reason="max_tokens"))])
    with pytest.raises(BadOutput, match="cut off"):
        provider(stub).complete(request())


def test_missing_key():
    with pytest.raises(MissingKey):
        ClaudeApiProvider("")
