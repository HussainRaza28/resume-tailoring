"""Tests for the Ollama provider against a local stand-in for the Ollama server."""

import json

import pytest

from app.core.schemas import RedFlagsReply
from app.providers.base import CompletionRequest, Offline, OtherError
from app.providers.ollama import OllamaProvider
from tests.http_stub import Stub

REPLY = json.dumps({"company": "Larkspur Freight", "role": "Platform Intern", "red_flags": []})


def ndjson(text):
    half = len(text) // 2
    lines = [
        {"message": {"role": "assistant", "content": text[:half]}, "done": False},
        {"message": {"role": "assistant", "content": text[half:]}, "done": False},
        {"message": {"role": "assistant", "content": ""}, "done": True, "prompt_eval_count": 900, "eval_count": 30},
    ]
    return "\n".join(json.dumps(line) for line in lines) + "\n"


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
    return CompletionRequest(step="red_flags", system="Rules.", context="The resume.", user="The posting.",
                             schema=RedFlagsReply)


def test_streams_lines_and_counts_usage(stub_factory):
    stub = stub_factory([(200, "application/x-ndjson", ndjson(REPLY))])
    seen = []
    out = OllamaProvider("llama3.2", host=stub.url).complete(request(), seen.append)
    assert out.data.company == "Larkspur Freight"
    assert "".join(seen) == REPLY
    assert (out.usage.input_tokens, out.usage.output_tokens) == (900, 30)
    body = stub.body_json()
    assert body["model"] == "llama3.2"
    assert body["format"]["additionalProperties"] is False
    assert body["messages"][0]["content"].startswith("Rules.\n\nThe resume.")
    assert body["options"]["num_ctx"] == 16384


def test_fenced_reply_is_accepted(stub_factory):
    stub = stub_factory([(200, "application/x-ndjson", ndjson(f"```json\n{REPLY}\n```"))])
    assert OllamaProvider("m", host=stub.url).complete(request()).data.role == "Platform Intern"


def test_missing_model_says_how_to_get_it(stub_factory):
    stub = stub_factory([(404, "application/json", '{"error": "model not found"}')])
    with pytest.raises(OtherError, match="ollama pull qwen3"):
        OllamaProvider("qwen3", host=stub.url).complete(request())


def test_error_line_mid_stream(stub_factory):
    stub = stub_factory([(200, "application/x-ndjson", '{"error": "out of memory"}\n')])
    with pytest.raises(OtherError, match="out of memory"):
        OllamaProvider("m", host=stub.url).complete(request())


def test_not_running():
    with pytest.raises(Offline, match="not running"):
        OllamaProvider("m", host="http://127.0.0.1:9").complete(request())
    with pytest.raises(Offline):
        OllamaProvider("m", host="http://127.0.0.1:9").list_models()


def test_list_models(stub_factory):
    tags = {"models": [{"name": "llama3.2:latest", "size": 2_000_000_000}, {"name": "qwen3:8b"}]}
    stub = stub_factory([(200, "application/json", json.dumps(tags))])
    assert OllamaProvider("m", host=stub.url).list_models() == [
        {"name": "llama3.2:latest", "size_bytes": 2_000_000_000},
        {"name": "qwen3:8b", "size_bytes": 0},
    ]
