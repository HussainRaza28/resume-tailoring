"""Tests for the shared provider interface, the Demo provider and the test fake."""

import pytest

from app.core.schemas import DiagnoseReply, RescoreReply, RewritesReply
from tests.sample_schema import SampleReply
from app.providers.base import (
    BadKey,
    BadOutput,
    CompletionRequest,
    RateLimited,
    ServerError,
    json_schema,
    parse_reply,
    with_retries,
)
from app.providers.demo import DemoProvider, rewrite_line
from tests.fake_provider import FakeProvider


def req(step, schema=SampleReply, user="u", context="c"):
    return CompletionRequest(step=step, system="s", context=context, user=user, schema=schema)


# -- schemas ---------------------------------------------------------------


def test_schemas_are_strict_and_inline():
    schema = json_schema(DiagnoseReply)
    assert "$defs" not in schema
    assert "$ref" not in str(schema)
    assert schema["additionalProperties"] is False
    keyword = schema["properties"]["missing_keywords"]["items"]
    assert keyword["additionalProperties"] is False
    assert set(keyword["required"]) == {"keyword", "evidence"}
    proposal = json_schema(RewritesReply)["properties"]["rewrites"]["items"]
    assert set(proposal["required"]) == {"bullet_id", "new_text", "sources", "question", "why"}


def test_every_field_is_required():
    for model in (DiagnoseReply, RewritesReply, RescoreReply):
        schema = json_schema(model)
        assert set(schema["required"]) == set(schema["properties"]), model.__name__


# -- parsing ---------------------------------------------------------------


def test_parse_reply_accepts_plain_and_fenced_json():
    good = '{"company": "A", "role": "B", "red_flags": []}'
    assert parse_reply(good, SampleReply).company == "A"
    assert parse_reply(f"```json\n{good}\n```", SampleReply).role == "B"


def test_parse_reply_rejects_wrong_shapes():
    for bad in ["nope", '{"company": "A"}', '{"company": "A", "role": "B", "red_flags": [], "extra": 1}']:
        with pytest.raises(BadOutput):
            parse_reply(bad, SampleReply)


# -- retries ---------------------------------------------------------------


def test_retries_only_retryable_errors():
    waits = []
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) == 1:
            raise RateLimited(retry_after_s=7)
        if len(calls) == 2:
            raise ServerError("overloaded")
        return "ok"

    assert with_retries(flaky, sleep=waits.append) == "ok"
    assert waits == [7, 4]

    bad_key_calls = []

    def bad_key():
        bad_key_calls.append(1)
        raise BadKey()

    with pytest.raises(BadKey):
        with_retries(bad_key, sleep=waits.append)
    assert len(bad_key_calls) == 1, "a rejected key isn't retried"


def test_retries_give_up_after_three_tries():
    def always_busy():
        raise ServerError()

    with pytest.raises(ServerError):
        with_retries(always_busy, sleep=lambda _s: None)


# -- the fake --------------------------------------------------------------


def test_fake_returns_scripted_replies_in_order():
    p = FakeProvider().reply("a", {"rewrites": []}).reply("a", {"rewrites": [
        {"bullet_id": "b1", "new_text": "x", "sources": ["b1"], "question": None, "why": "y"}]})
    assert p.complete(req("a", RewritesReply)).data.rewrites == []
    assert len(p.complete(req("a", RewritesReply)).data.rewrites) == 1
    assert len(p.complete(req("a", RewritesReply)).data.rewrites) == 1
    assert p.call_count("a") == 3


def test_fake_streams_and_reports_usage():
    p = FakeProvider().reply("a", {"company": "", "role": "", "red_flags": []})
    seen = []
    out = p.complete(req("a"), seen.append)
    assert "".join(seen) == '{"company": "", "role": "", "red_flags": []}'
    assert out.usage.output_tokens > 0
    assert out.model == "fake-1"


# -- the Demo provider -----------------------------------------------------


def test_demo_diagnose_takes_the_role_from_the_posting_and_scores_the_resume():
    resume = "- [b1] Cut calls from 12,000 to 3,000\n- [b2] Worked with the team"
    user = "Read this.\n<job_posting>\nPlatform Intern\nMore\n</job_posting>"
    out = DemoProvider().complete(req("diagnose", DiagnoseReply, user, context=resume)).data
    assert out.role == "Platform Intern"
    assert len(out.red_flags) == 3
    assert out.ats_score == out.hiring_manager_score == 52 + 3 - 6


def test_demo_rewrites_only_vague_bullets():
    user = "[b2] (Northwind) Built a Python service\n[b5] (Northwind) Worked with the team on backend tasks\n"
    out = DemoProvider().complete(req("rewrite", RewritesReply, user)).data.rewrites
    assert [p.bullet_id for p in out] == ["b2", "b5"]
    assert out[0].new_text == "Built a Python service" and out[0].question is None
    assert out[1].new_text == "Worked alongside the team on backend tasks"
    assert out[1].question and out[1].sources == ["b5"]


def test_demo_rewrite_line():
    assert rewrite_line("Helped patrons fix printers") == ("Supported patrons fix printers", rewrite_line("Helped x")[1])
    assert rewrite_line("Assisted the lead")[0] == "Handled the lead"


def test_demo_rescore_counts_both_resumes_and_each_change():
    user = (
        "<resume_a>\n- [b1] Built a thing\n- [b2] Worked with the team\n</resume_a>\n"
        "<resume_b>\n- [b1] Built a thing for 40 users\n- [b2] Worked alongside the team\n</resume_b>\n"
        "<changes>\n[b1]\n  before: Built a thing\n  after: Built a thing for 40 users\n"
        "[b2]\n  before: Worked with the team\n  after: Worked alongside the team\n</changes>"
    )
    out = DemoProvider().complete(req("rescore", RescoreReply, user)).data
    assert out.base_ats_score == 52 - 6
    assert out.tailored_ats_score == 52 + 3
    assert {c.bullet_id: c.effect for c in out.changes} == {"b1": 3, "b2": 6}


def test_demo_streams_in_chunks():
    chunks = []
    DemoProvider().complete(req("diagnose", DiagnoseReply, user="<job_posting>\nX\n</job_posting>"), chunks.append)
    assert len(chunks) > 1
    assert all(len(c) <= 64 for c in chunks)
