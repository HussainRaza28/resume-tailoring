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
    RUBRIC,
    Diagnosis,
    ScoreCard,
    coverage_for,
    diagnose,
    diagnose_prompt,
    export_edits,
    rescore,
    rescore_prompt,
    rewrite,
    rewrite_prompt,
    skills_reorder_edits,
    trim_hints,
)
from app.core.schemas import Proposal, RedFlag, SkippedSection
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


def test_prompts_keep_the_original_wording():
    diag = diagnose_prompt("Acme", "p", "(empty)")
    assert "The top 3 red flags a hiring manager spots in under 10 seconds" in diag
    assert "reading 200 resumes in one sitting" in diag
    assert "Be brutally honest, with no compliments or padding." in diag
    assert "(Acme)" in diag and "()" not in diagnose_prompt("", "p", "(empty)")
    rw = rewrite_prompt("p", None, "", [], "")
    assert "Lead every line with measurable impact using the Google XYZ formula" in rw
    assert "strip out every generic phrase" in rw
    assert "reading 200 resumes in one sitting" in rescore_prompt("p", "a", "b", [])
    assert "Never suggest a summary, objective or profile section." in SYSTEM


def test_diagnose_and_rescore_share_one_rubric():
    assert RUBRIC in diagnose_prompt("", "p", "(empty)")
    assert RUBRIC in rescore_prompt("p", "a", "b", [])


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


def diagnosis_reply(**changes):
    reply = {
        "company": "Acme", "role": "Backend Intern", "ats_score": 61, "hiring_manager_score": 54, "verdict": "Thin.",
        "red_flags": [
            {"flag": "Add a professional summary", "why": "Recruiters like them", "section": "Header"},
            {"flag": "Vague teamwork bullet", "why": "Says nothing", "section": "Experience"},
            {"flag": "No scale numbers", "why": "Backend role", "section": "Projects"},
            {"flag": "Library job", "why": "Unrelated", "section": "Experience"},
            {"flag": "Extra", "why": "x", "section": "x"}],
        "skipped_sections": [
            {"section": "Summary", "reason": "There isn't one"},
            {"section": "Projects", "reason": "Generic verbs"}],
        "missing_keywords": [],
    }
    reply.update(changes)
    return reply


def test_diagnose_scores_and_drops_summary_advice(ctx):
    p = FakeProvider().reply("diagnose", diagnosis_reply())
    found, stats = diagnose(p, ctx, "", "posting", FactsBank())
    assert (found.score.ats, found.score.hiring_manager, found.score.overall) == (61, 54, 58)
    assert [f.flag for f in found.red_flags] == ["Vague teamwork bullet", "No scale numbers", "Library job"]
    assert [s.section for s in found.skipped_sections] == ["Projects"], "never a summary section"
    assert found.company == "Acme" and found.verdict == "Thin."
    assert stats.step == "diagnose"
    request = p.calls[0]
    assert "[b2]" in request.context
    assert request.system == SYSTEM
    assert "<facts_bank>" in request.user


def test_diagnose_scores_are_clamped():
    assert ScoreCard.of(140, -5) == ScoreCard(ats=100, hiring_manager=0, overall=50)


def test_diagnose_keeps_only_keywords_with_real_evidence(ctx):
    facts = FactsBank()
    fact_id = facts.add("Used Redis to cache route lookups at Northwind")
    reply = diagnosis_reply(missing_keywords=[
        {"keyword": "Postgres", "evidence": ["b3"]},  # b3 says PostgreSQL: same skill, another name
        {"keyword": "Redis", "evidence": ["b2", fact_id]},  # only the fact backs it
        {"keyword": "Kubernetes", "evidence": ["b2"]},  # b2 never mentions it
        {"keyword": "Kafka", "evidence": ["f99"]},  # no such fact
        {"keyword": "batches", "evidence": ["b2"]},  # not a known skill, but the word is there
        {"keyword": "redis", "evidence": [fact_id]},  # a repeat
    ])
    found, _ = diagnose(FakeProvider().reply("diagnose", reply), ctx, "", "posting", facts)
    assert [(k.keyword, k.evidence) for k in found.missing_keywords] == [
        ("Postgres", ["b3"]), ("Redis", [fact_id]), ("batches", ["b2"])]


def test_rewrite_is_aimed_at_the_diagnosis(ctx):
    diagnosis = Diagnosis(
        score=ScoreCard.of(60, 50),
        red_flags=[RedFlag(flag="Vague teamwork bullet", why="Says nothing", section="Experience")],
        skipped_sections=[SkippedSection(section="Projects", reason="Generic verbs")],
    )
    p = FakeProvider().reply("rewrite", {"rewrites": []})
    rewrite(p, ctx, "posting", diagnosis, FactsBank())
    user = p.calls[0].user
    assert "fix exactly what the diagnosis below found" in user
    assert "1. Vague teamwork bullet (Experience): Says nothing" in user
    assert "- Projects: Generic verbs" in user


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
    diagnosis = Diagnosis(score=ScoreCard.of(50, 50), red_flags=[RedFlag(flag="f", why="w", section="Experience")])
    out, stats = rewrite(p, ctx, "posting", diagnosis, FactsBank())
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
    out, _ = rewrite(p, ctx, "posting", None, FactsBank(), only=["b2"])
    assert len(out) == 1 and out[0].status == BLOCKED


def test_failed_retry_keeps_first_result(ctx):
    bad = {"rewrites": [{"bullet_id": "b2", "new_text": "Saved $1M", "sources": ["b2"], "question": None, "why": ""}]}
    p = FakeProvider().reply("rewrite", bad).fail("rewrite_retry", ServerError())
    out, stats = rewrite(p, ctx, "posting", None, FactsBank(), only=["b2"])
    assert out[0].status == BLOCKED and len(stats) == 1


def rescore_reply(**changes):
    reply = {"base_ats_score": 60, "base_hiring_manager_score": 56, "tailored_ats_score": 70,
             "tailored_hiring_manager_score": 66, "verdict": "Better.", "changes": []}
    reply.update(changes)
    return reply


def test_rescore_scores_both_resumes_in_one_call(ctx):
    accepted = "Made a Discord bot that tracks roommate expenses and posts a weekly summary"
    provider = FakeProvider().reply("rescore", rescore_reply())
    result, stats = rescore(provider, ctx, "posting", {"b10": accepted})
    assert provider.call_count("rescore") == 1, "one call, so both scores come from the same reading"
    assert (result.base.overall, result.tailored.overall) == (58, 68)
    user = provider.calls[0].user
    resume_a = user.split("<resume_a>\n", 1)[1].split("</resume_a>", 1)[0]
    resume_b = user.split("<resume_b>\n", 1)[1].split("</resume_b>", 1)[0]
    assert accepted not in resume_a and f"- [b10] {accepted}" in resume_b
    assert f"[b10]\n  before: {ctx.doc.text('b10')}\n  after: {accepted}" in user
    assert result.scored == {"b10": accepted}
    assert stats.step == "rescore"


def test_rescore_flags_changes_that_lower_the_score(ctx):
    changes = [
        {"bullet_id": "b10", "effect": -4, "reason": "Lost the weekly summary"},
        {"bullet_id": "b2", "effect": 3, "reason": "Scale up front"},
        {"bullet_id": "b7", "effect": -2, "reason": "Not a change at all"},
    ]
    replaced = {"b10": "Made a Discord bot for roommates", "b2": "Cut mapping API calls from 12,000 to 3,000 per day"}
    result, _ = rescore(FakeProvider().reply("rescore", rescore_reply(changes=changes)), ctx, "p", replaced)
    assert [(c.bullet_id, c.lowers_score) for c in result.changes] == [("b10", True), ("b2", False)]


def test_rescore_lists_removed_bullets_as_changes(ctx):
    provider = FakeProvider().reply("rescore", rescore_reply())
    rescore(provider, ctx, "p", {"b5": ""})
    user = provider.calls[0].user
    assert "[b5]\n  before: Worked with the team" in user and "after: (removed)" in user
    assert "[b5]" not in user.split("<resume_b>\n", 1)[1].split("</resume_b>", 1)[0]


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
    found, _ = diagnose(demo, ctx, "", POSTING, FactsBank())
    assert len(found.red_flags) == 3
    out, _ = rewrite(demo, ctx, POSTING, found, FactsBank())
    changed = [r for r in out if r.status != UNCHANGED]
    assert len(changed) == 2, "only the two vague bullets change"
    for r in changed:
        assert r.status == OK, r.reasons
        assert r.question
    scored, _ = rescore(demo, ctx, POSTING, {r.bullet_id: r.new_text for r in changed})
    assert scored.tailored.overall > scored.base.overall, "the vague openers were replaced"
    assert scored.base.overall == found.score.overall, "the same count as Diagnose"
    assert {c.bullet_id for c in scored.changes} == {r.bullet_id for r in changed}
    tex = ctx.doc.apply(export_edits(ctx.doc, {r.bullet_id: r.new_text for r in changed}, [],
                                     skills.extract_posting_skills(POSTING)))
    assert "Worked alongside the team" in tex
