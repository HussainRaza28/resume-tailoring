"""Tests for the Gemini provider against a local stand-in for the API."""

import json

import pytest

from tests.sample_schema import SampleReply
from app.providers.base import BadKey, BadOutput, CompletionRequest, MissingKey, Offline, RateLimited, ServerError
from app.providers.gemini import GeminiProvider
from tests.http_stub import Stub

REPLY = {"company": "Larkspur Freight", "role": "Platform Intern", "red_flags": []}


def chunk(parts, finish=None, usage=None):
    candidate = {"content": {"role": "model", "parts": parts}, "index": 0}
    if finish:
        candidate["finishReason"] = finish
    out = {"candidates": [candidate], "modelVersion": "gemini-3-flash"}
    if usage:
        out["usageMetadata"] = usage
    return out


def data_stream(chunks):
    return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks)


def good_stream(text, finish="STOP"):
    half = len(text) // 2
    return data_stream([
        chunk([{"text": "Weighing the posting...", "thought": True}]),
        chunk([{"text": text[:half]}]),
        chunk([{"text": text[half:]}], finish=finish, usage={
            "promptTokenCount": 1000, "cachedContentTokenCount": 800,
            "candidatesTokenCount": 30, "thoughtsTokenCount": 12}),
    ])


def error_body(code, status, message):
    return json.dumps({"error": {"code": code, "status": status, "message": message}})


@pytest.fixture
def stub_factory():
    stubs = []

    def make(replies):
        stubs.append(Stub(replies))
        return stubs[-1]

    yield make
    for s in stubs:
        s.close()


def request():
    return CompletionRequest(step="diagnose", system="Rules.", context="The resume.", user="The posting.",
                             schema=SampleReply)


def test_streams_skips_thoughts_and_counts_usage(stub_factory):
    stub = stub_factory([(200, "text/event-stream", good_stream(json.dumps(REPLY)))])
    seen = []
    out = GeminiProvider("key", base_url=stub.url).complete(request(), seen.append)
    assert out.data == SampleReply(**REPLY)
    assert "".join(seen) == json.dumps(REPLY), "thinking text never reaches the interface"
    assert (out.usage.input_tokens, out.usage.cache_read_tokens, out.usage.output_tokens) == (200, 800, 42)
    assert out.model == "gemini-3-flash"


def test_request_shape(stub_factory):
    stub = stub_factory([(200, "text/event-stream", good_stream(json.dumps(REPLY)))])
    GeminiProvider("key", model="gemini-test", base_url=stub.url).complete(request())
    sent = stub.requests[-1]
    assert "models/gemini-test:streamGenerateContent" in sent["path"]
    assert sent["headers"]["x-goog-api-key"] == "key"
    body = json.loads(sent["body"])
    assert body["systemInstruction"]["parts"][0]["text"] == "Rules.\n\nThe resume."
    config = body["generationConfig"]
    assert config["responseMimeType"] == "application/json"
    assert config["responseJsonSchema"]["additionalProperties"] is False


def test_blocked_and_cut_off_replies_are_errors(stub_factory):
    stub = stub_factory([(200, "text/event-stream", good_stream("{}", finish="SAFETY"))])
    with pytest.raises(BadOutput, match="SAFETY"):
        GeminiProvider("key", base_url=stub.url).complete(request())
    stub = stub_factory([(200, "text/event-stream", good_stream('{"company": "', finish="MAX_TOKENS"))])
    with pytest.raises(BadOutput, match="cut off"):
        GeminiProvider("key", base_url=stub.url).complete(request())


def test_errors_are_mapped(stub_factory, monkeypatch):
    monkeypatch.setattr("app.providers.base.time.sleep", lambda _s: None)
    cases = [
        (400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", BadKey),
        (403, "PERMISSION_DENIED", "denied", BadKey),
        (429, "RESOURCE_EXHAUSTED", "quota", RateLimited),
        (503, "UNAVAILABLE", "overloaded", ServerError),
    ]
    for code, status, message, expected in cases:
        stub = stub_factory([(code, "application/json", error_body(code, status, message))])
        with pytest.raises(expected):
            GeminiProvider("key", base_url=stub.url).complete(request())


def test_offline():
    with pytest.raises(Offline):
        GeminiProvider("key", base_url="http://127.0.0.1:9").complete(request())


def test_list_models(stub_factory):
    models = {"models": [
        {"name": "models/gemini-3-flash", "supportedGenerationMethods": ["generateContent", "countTokens"]},
        {"name": "models/gemini-embedding", "supportedGenerationMethods": ["embedContent"]},
        {"name": "models/imagen-4", "supportedGenerationMethods": ["predict"]},
    ]}
    stub = stub_factory([(200, "application/json", json.dumps(models))])
    assert GeminiProvider("key", base_url=stub.url).list_models() == ["gemini-3-flash"]


def test_missing_key():
    with pytest.raises(MissingKey):
        GeminiProvider("")
