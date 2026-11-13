"""Tests for the tailoring steps, using the scripted provider and the sample resume."""

from pathlib import Path

import pytest

from app.core import skills
from app.core.facts import FactsBank
from app.core.pipeline import (
    BLOCKED,
    CHARS_PER_LINE,
    OK,
    SYSTEM,
    UNCHANGED,
    Context,
    clean_model_text,
    coverage_for,
    export_edits,
    red_flags,
    review,
    review_prompt,
    rewrite,
    rewrite_prompt,
    red_flags_prompt,
    skills_reorder_edits,
    trim_hints,
)
from app.core.schemas import Proposal, RedFlag
from app.providers.base import ServerError
from app.providers.demo import DemoProvider
from tests.fake_provider import FakeProvider

SAMPLE = (Path(__file__).parent / "fixtures" / "sample_resume.tex").read_text(encoding="utf-8")
POSTING = (Path(__file__).parent / "fixtures" / "sample_posting.txt").read_text(encoding="utf-8")


@pytest.fixture
def ctx():
    return Context(SAMPLE)


def proposal(bid, text, sources=(), question=None):
    return Proposal(bullet_id=bid, new_text=text, sources=list(sources), question=question, why="")


def test_prompts_use_the_exact_wording():
    assert "Give me the top 3 red flags a hiring manager spots in under 10 seconds." in red_flags_prompt("Acme", "p")
    assert "(Acme)" in red_flags_prompt("Acme", "p") and "()" not in red_flags_prompt("", "p")
    assert "Lead every line with measurable impact using the Google XYZ formula" in rewrite_prompt("p", [], "", [], "")
    assert "reading 200 resumes in one sitting" in review_prompt("p", "r")
    assert "Never suggest a summary, objective or profile section." in SYSTEM


def test_base_plain_lists_bullets_with_ids(ctx):
    assert "- [b2] Built a Python service" in ctx.base_plain
    assert "### Northwind Logistics | Software Engineering Intern, Routing Team" in ctx.base_plain
    assert "Languages: Python, TypeScript" in ctx.base_plain
    assert len(ctx.rewrite_targets()) == 10


def test_check_accepts_grounded_and_blocks_invented(ctx):
    facts = FactsBank()
    ok = ctx.check(proposal("b2", "Cut mapping API calls from 12,000 to 3,000 per day by batching delivery route "
                                  "updates in a Python service", ["b2"]), facts)
    assert ok.status == OK, ok.reasons
    bad = ctx.check(proposal("b2", "Cut mapping API calls 75% with a Python service, saving $40,000 a year", ["b2"]), facts)
    assert bad.status == BLOCKED
    assert any("75%" in r for r in bad.reasons)
    styled = ctx.check(proposal("b2", "Leveraged Python to cut mapping API calls from 12,000 to 3,000 per day", ["b2"]), facts)
    assert styled.status == BLOCKED
    assert any(r.startswith("Stock word") for r in styled.reasons)
    same = ctx.check(proposal("b3", ctx.doc.text("b3"), ["b3"]), facts)
    assert same.status == UNCHANGED


def test_own_bullet_is_always_a_source_and_heading_counts(ctx):
    r = ctx.check(proposal("b2", "Built a Python service at Northwind Logistics that batches delivery route updates"),
                  FactsBank())
    assert r.sources[0] == "b2"
    assert r.status == OK, r.reasons


def test_facts_unlock_numbers_and_answered_questions_are_not_repeated(ctx):
    facts = FactsBank()
    old = ctx.doc.text("b8")
    text = "Built a web app for logging hikes on an interactive map, used by 140 members and 12 trail guides"
    assert ctx.check(proposal("b8", text, ["b8"]), facts).status == BLOCKED
    fid = facts.add("TrailMap is also used by 12 trail guides", "How many guides use it?", old)
    ok = ctx.check(proposal("b8", text, ["b8", fid], question="How many guides use it?"), facts)
    assert ok.status == OK, ok.reasons
    assert ok.question is None, "already answered"


def test_non_bullet_ids_are_ignored(ctx):
    assert ctx.check(proposal("s1", "Python"), FactsBank()) is None
    assert ctx.check(proposal("b999", "x"), FactsBank()) is None


FLAGS = {"company": "Acme", "role": "Backend Intern", "red_flags": [
    {"flag": "Add a professional summary", "why": "Recruiters like them", "section": "Header"},
    {"flag": "Vague teamwork bullet", "why": "Says nothing", "section": "Experience"},
    {"flag": "No scale numbers", "why": "Backend role", "section": "Projects"},
    {"flag": "Library job", "why": "Unrelated", "section": "Experience"},
    {"flag": "Extra", "why": "x", "section": "x"}]}


def test_red_flags_drops_summary_advice_and_keeps_three(ctx):
    p = FakeProvider().reply("red_flags", FLAGS)
    rf, stats = red_flags(p, ctx, "", "posting")
    assert [f.flag for f in rf.red_flags] == ["Vague teamwork bullet", "No scale numbers", "Library job"]
    assert rf.company == "Acme"
    assert stats.step == "red_flags"
    request = p.calls[0]
    assert "[b2]" in request.context
    assert request.system == SYSTEM


def test_rewrite_retries_blocked_bullets_once(ctx):
    first = {"rewrites": [
        {"bullet_id": "b2", "new_text": "Cut mapping API calls 75% with a batching Python service", "sources": ["b2"],
         "question": None, "why": "scale"},
        {"bullet_id": "b5", "new_text": "Reviewed code for the backend team", "sources": ["b5"],
         "question": "How many pull requests did you review?", "why": "vague"}]}
    second = {"rewrites": [
        {"bullet_id": "b2", "new_text": "Cut mapping API calls from 12,000 to 3,000 per day with a batching Python service",
         "sources": ["b2"], "question": None, "why": "scale"}]}
    p = FakeProvider().reply("rewrite", first).reply("rewrite_retry", second)
    flags = [RedFlag(flag="f", why="w", section="Experience")]
    out, stats = rewrite(p, ctx, "posting", flags, FactsBank())
    assert len(out) == 10, "one entry per target bullet"
    b2 = next(r for r in out if r.bullet_id == "b2")
    assert b2.status == OK, b2.reasons
    assert "12,000 to 3,000" in b2.new_text
    b5 = next(r for r in out if r.bullet_id == "b5")
    assert b5.question == "How many pull requests did you review?"
    assert len(stats) == 2
    assert stats[0].blocked_claims == 1, "the invented 75% is counted before blocking"
    assert stats[0].blocked_by_kind == {"number": 1}
    assert p.call_count("rewrite_retry") == 1
    retry_user = p.calls[1].user
    assert "[b2]" in retry_user and "[b5] (" not in retry_user
    assert "were blocked by the checker" in retry_user


def test_still_blocked_after_retry_stays_blocked(ctx):
    bad = {"rewrites": [{"bullet_id": "b2", "new_text": "Saved Northwind $1M with Rust", "sources": ["b2"],
                         "question": None, "why": ""}]}
    p = FakeProvider().reply("rewrite", bad).reply("rewrite_retry", bad)
    out, _ = rewrite(p, ctx, "posting", [], FactsBank(), only=["b2"])
    assert len(out) == 1 and out[0].status == BLOCKED


def test_failed_retry_keeps_first_result(ctx):
    bad = {"rewrites": [{"bullet_id": "b2", "new_text": "Saved $1M", "sources": ["b2"], "question": None, "why": ""}]}
    p = FakeProvider().reply("rewrite", bad).fail("rewrite_retry", ServerError())
    out, stats = rewrite(p, ctx, "posting", [], FactsBank(), only=["b2"])
    assert out[0].status == BLOCKED and len(stats) == 1


def test_review_drops_summary_suggestions_and_checks_rewrites(ctx):
    reply = {"score": 140, "verdict": "ok", "skipped_sections": [
        {"section": "Professional Summary", "reason": "missing", "rewrites": []},
        {"section": "Projects", "reason": "weak verbs", "rewrites": [
            {"bullet_id": "b10", "new_text": "Made a Discord bot that tracks shared roommate expenses and posts a "
                                             "weekly summary", "sources": ["b10"], "question": None, "why": ""},
            {"bullet_id": "s1", "new_text": "Rust", "sources": [], "question": None, "why": ""}]}]}
    p = FakeProvider().reply("review_after", reply)
    rev, _ = review(p, ctx, "posting", {}, FactsBank(), "review_after")
    assert rev.score == 100, "clamped"
    assert [s.section for s in rev.skipped_sections] == ["Projects"]
    assert len(rev.skipped_sections[0].rewrites) == 1, "a skills-line rewrite is ignored"
    assert rev.skipped_sections[0].rewrites[0].status == OK


def test_review_compares_with_accepted_text(ctx):
    accepted = "Made a Discord bot that tracks roommate expenses and posts a weekly summary"
    reply = {"score": 70, "verdict": "ok", "skipped_sections": [{"section": "Projects", "reason": "r", "rewrites": [
        {"bullet_id": "b10", "new_text": accepted, "sources": ["b10"], "question": None, "why": ""}]}]}
    provider = FakeProvider().reply("review", reply)
    rev, _ = review(provider, ctx, "p", {"b10": accepted}, FactsBank())
    r = rev.skipped_sections[0].rewrites[0]
    assert r.old_text == accepted and r.status == UNCHANGED
    assert f"- [b10] {accepted}" in provider.calls[0].user, "the review scores the resume as it stands"


def test_skills_reorder_puts_matches_first_without_adding(ctx):
    posting = skills.extract_posting_skills("Requirements:\n- SQL and Java\nNice to have: Docker")
    out = ctx.doc.apply(skills_reorder_edits(ctx.doc, posting))
    assert "\\textbf{Languages}{: Java, SQL, Python, TypeScript, JavaScript}" in out
    assert "{: Docker, PostgreSQL, SQLite, Git, GitHub Actions, Linux}" in out


def test_export_edits_apply_cleanly_and_coverage_moves(ctx):
    posting = skills.extract_posting_skills("Requirements: Python, Redis, Kubernetes")
    facts = FactsBank()
    facts.add("Used Redis to cache route lookups at Northwind")
    accepted = {"b3": "Added PostgreSQL indexes and Redis caching to the shipment lookup query after profiling "
                      "showed full table scans on 2 million rows"}
    before = coverage_for(ctx, posting, {}, facts)
    after = coverage_for(ctx, posting, accepted, facts)
    assert (before.required_have, before.required_covered) == (2, 1)
    assert (after.required_have, after.required_covered) == (2, 2)
    tex = ctx.doc.apply(export_edits(ctx.doc, accepted, ["b5"], posting))
    assert "Redis caching" in tex
    assert "various backend tasks" not in tex


def test_trim_hints_prefer_short_tails(ctx):
    current = {"b2": "x" * (CHARS_PER_LINE + 5), "b3": "y" * (CHARS_PER_LINE + 40)}
    hints = trim_hints(ctx.doc, current)
    assert hints[0].bullet_id == "b2" and hints[0].cut_chars == 5
    assert any(h.bullet_id == "b3" and h.cut_chars == 40 for h in hints)


def test_clean_text():
    assert clean_model_text('  - "Built a thing." ') == "Built a thing"
    assert clean_model_text("Built   a\nthing.") == "Built a thing"


def test_demo_runs_the_whole_flow_on_the_fixture(ctx):
    demo = DemoProvider()
    rf, _ = red_flags(demo, ctx, "", POSTING)
    assert len(rf.red_flags) == 3
    out, _ = rewrite(demo, ctx, POSTING, rf.red_flags, FactsBank())
    changed = [r for r in out if r.status != UNCHANGED]
    assert len(changed) == 2, "only the two vague bullets change"
    for r in changed:
        assert r.status == OK, r.reasons
        assert r.question
    rev, _ = review(demo, ctx, POSTING, {r.bullet_id: r.new_text for r in changed}, FactsBank(), "review_after")
    assert 0 < rev.score <= 100
    tex = ctx.doc.apply(export_edits(ctx.doc, {r.bullet_id: r.new_text for r in changed}, [],
                                     skills.extract_posting_skills(POSTING)))
    assert "Worked alongside the team" in tex
