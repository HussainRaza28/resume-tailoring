"""Tests for the tailoring steps, using the scripted provider and the sample resume."""

from pathlib import Path

import pytest

from app.core import skills
from app.core.facts import FactsBank
from app.core.pipeline import (
    BLOCKED,
    CHARS_PER_LINE,
    OK,
    RUBRIC,
    SYSTEM,
    UNCHANGED,
    Context,
    clean_model_text,
    coverage_for,
    dropped_specifics,
    export_edits,
    rescore,
    rescore_prompt,
    rewrite,
    rewrite_prompt,
    score,
    score_prompt,
    skills_reorder_edits,
    split_note,
    trim_hints,
)
from app.core.schemas import Proposal, RedFlag
from app.providers.base import ServerError
from app.providers.demo import DemoProvider
from tests.fake_provider import FakeProvider

SAMPLE = (Path(__file__).parent / "fixtures" / "sample_resume.tex").read_text(encoding="utf-8")
POSTING = (Path(__file__).parent / "fixtures" / "sample_posting.txt").read_text(encoding="utf-8")
FLAG = RedFlag(flag="Vague teamwork bullet", why="Says nothing", section="Experience")


@pytest.fixture
def ctx():
    return Context(SAMPLE)


def proposal(bid, text, sources=()):
    return Proposal(bullet_id=bid, new_text=text, sources=list(sources), why="")


def test_prompts_keep_the_original_wording():
    sp = score_prompt("Acme", "p")
    assert "top 3 red flags a hiring manager spots in under 10 seconds" in sp
    assert "Be brutally honest, with no compliments or padding." in sp
    assert "(Acme)" in sp and "()" not in score_prompt("", "p")
    rw = rewrite_prompt("p", [("a1", "Vague teamwork bullet (Experience): Says nothing")], [], "", [], "")
    assert "Rewrite my experience section to kill those red flags." in rw
    assert "Lead every line with measurable impact using the Google XYZ formula" in rw
    assert "strip out every generic phrase" in rw
    assert "Never suggest a summary, objective or profile section." in SYSTEM


def test_score_and_done_share_one_rubric():
    assert RUBRIC in score_prompt("", "p")
    assert RUBRIC in rescore_prompt("p", "a", "b")


def test_base_plain_lists_bullets_with_ids(ctx):
    assert "- [b2] Built a Python service" in ctx.base_plain
    assert "### Northwind Logistics | Software Engineering Intern, Routing Team" in ctx.base_plain
    assert "Languages: Python, TypeScript" in ctx.base_plain
    targets = ctx.rewrite_targets()
    assert len(targets) == 16, "11 bullets (coursework included), 2 tech stacks and 3 skills lines"
    assert targets[-2] == ("s2", "Technical Skills | Frameworks & Libraries", "React, Node.js, Express, pytest, pandas")


def test_check_accepts_grounded_and_blocks_invented(ctx):
    facts = FactsBank()
    ok = ctx.check(proposal("b2", "Cut mapping API calls from 12,000 to 3,000 per day by batching delivery route "
                                  "updates in a Python service", ["b2"]), facts)
    assert ok.status == OK, ok.reasons
    bad = ctx.check(proposal("b2", "Cut mapping API calls 75% with a Python service, saving $40,000 a year", ["b2"]), facts)
    assert bad.status == BLOCKED
    assert any("75%" in r for r in bad.reasons)
    # Style findings warn and never block.
    styled = ctx.check(proposal("b2", "Leveraged Python to cut mapping API calls from 12,000 to 3,000 per day", ["b2"]), facts)
    assert styled.status == OK
    assert styled.reasons == []
    assert any(w.startswith("Stock word") for w in styled.warnings)
    same = ctx.check(proposal("b3", ctx.doc.text("b3"), ["b3"]), facts)
    assert same.status == UNCHANGED


def test_own_bullet_is_always_a_source_and_heading_counts(ctx):
    r = ctx.check(proposal("b2", "Built a Python service at Northwind Logistics that batches delivery route updates, "
                                 "cutting API calls to the mapping provider from 12,000 to 3,000 per day"), FactsBank())
    assert r.sources[0] == "b2"
    assert r.status == OK, r.reasons


def test_facts_unlock_numbers(ctx):
    facts = FactsBank()
    text = "Built a web app for logging hikes on an interactive map, used by 140 members and 12 trail guides"
    assert ctx.check(proposal("b8", text, ["b8"]), facts).status == BLOCKED
    fid = facts.add("TrailMap is also used by 12 trail guides")
    ok = ctx.check(proposal("b8", text, ["b8", fid]), facts)
    assert ok.status == OK, ok.reasons


def test_ids_that_are_not_lines_are_ignored_and_protected_lines_are_blocked(ctx):
    assert ctx.check(proposal("b999", "x"), FactsBank()) is None
    employer = ctx.check(proposal("h2.0", "Acme"), FactsBank())
    assert employer.status == BLOCKED
    assert 'Changes "Northwind Logistics", a protected fact (employer).' in employer.reasons[-1]


# -- never less specific ------------------------------------------------------


def test_a_rewrite_may_not_drop_a_number_tool_or_name(ctx):
    original = ctx.doc.text("b2")  # Python, 12,000 and 3,000
    assert dropped_specifics(original, original) == []
    assert set(dropped_specifics(original, "Built a service that batches delivery route updates")) == {
        "Python", "API", "12,000", "3,000"}
    vaguer = ctx.check(proposal("b2", "Cut mapping API calls by batching delivery route updates in a Python service",
                                ["b2"]), FactsBank())
    # Lost detail is a warning: the rewrite can still be accepted.
    assert vaguer.status == OK
    assert set(vaguer.dropped) == {"12,000", "3,000"}
    assert 'Drops "12,000" from the original.' in vaguer.warnings
    less_technical = ctx.check(proposal("b3", "Sped up the shipment lookup query after profiling showed full table "
                                              "scans on 2 million rows", ["b3"]), FactsBank())
    assert less_technical.status == OK and less_technical.dropped == ["PostgreSQL"]
    assert less_technical.warnings == ['Drops "PostgreSQL" from the original.']


def test_adding_detail_from_a_fact_is_fine(ctx):
    facts = FactsBank()
    fid = facts.add("Added Redis caching to route lookups at Northwind")
    more = ctx.check(proposal("b3", "Added PostgreSQL indexes and Redis caching to the shipment lookup query after "
                                    "profiling showed full table scans on 2 million rows", ["b3", fid]), facts)
    assert more.status == OK, more.reasons
    assert more.dropped == []


# -- Score -------------------------------------------------------------------------


def score_reply(**changes):
    reply = {
        "company": "Acme", "role": "Backend Intern", "ats_score": 61,
        "red_flags": [
            {"flag": "Add a professional summary", "why": "Recruiters like them", "section": "Header"},
            {"flag": "Vague teamwork bullet", "why": "Says nothing", "section": "Experience"},
            {"flag": "No scale numbers", "why": "Backend role", "section": "Projects"},
            {"flag": "Library job", "why": "Unrelated", "section": "Experience"},
            {"flag": "Extra", "why": "x", "section": "x"}],
    }
    reply.update(changes)
    return reply


def test_score_gives_the_ats_score_and_three_flags_without_summary_advice(ctx):
    p = FakeProvider().reply("score", score_reply())
    found, stats = score(p, ctx, "", "posting")
    assert found.ats == 61 and found.company == "Acme" and found.role == "Backend Intern"
    assert [f.flag for f in found.red_flags] == ["Vague teamwork bullet", "No scale numbers", "Library job"]
    assert stats.step == "score"
    request = p.calls[0]
    assert "[b2]" in request.context and request.system == SYSTEM
    assert "<facts_bank>" not in request.user, "the score is of the page, so it stays small"
    assert request.max_tokens <= 2000


def test_score_is_clamped(ctx):
    found, _ = score(FakeProvider().reply("score", score_reply(ats_score=140)), ctx, "", "p")
    assert found.ats == 100


# -- the note ----------------------------------------------------------------------


def test_a_note_splits_into_facts():
    note = (
        "TrailMap had 25 contributors on GitHub. I also used Redis to cache lookups at Northwind!\n"
        "- Wrote the Node.js API in 2 weeks\n"
        "* ok\n"
        "it handled 40 requests a second. e.g. fine\n"
        "\n"
        "Mentored 3 interns. Mentored 3 interns."
    )
    assert split_note(note) == [
        "TrailMap had 25 contributors on GitHub",
        "I also used Redis to cache lookups at Northwind!",
        "Wrote the Node.js API in 2 weeks",
        "it handled 40 requests a second",
        "Mentored 3 interns",
    ]
    assert split_note("   ") == []


# -- Rewrite -----------------------------------------------------------------------


def test_rewrite_works_through_advice_then_notes_then_its_own_improvements(ctx):
    p = FakeProvider().reply("rewrite", {"rewrites": []})
    rewrite(p, ctx, "posting", [FLAG], [("Redis", "f1"), ("Docker", "base resume")], FactsBank())
    user = p.calls[0].user
    assert "[a1] Vague teamwork bullet (Experience): Says nothing" in user
    assert "[a2] Show Redis, backed up by f1. Add it to the line where it fits." in user
    assert "[a3] Show Docker, backed up by base resume." in user
    assert user.index("1. Every advice item from the score.") < user.index("2. Every note I added.") < user.index(
        "3. Then the obvious improvements you find yourself")
    assert "Never make a line less specific or less technical" in user
    assert "`items`: one entry per advice item and note id" in user
    # Protected parts are listed, so the model knows what it may not touch.
    assert '[h4.0] "TrailMap"' in user and '[b1] "Relevant Coursework:"' in user


def test_rewrite_retries_blocked_bullets_once(ctx):
    first = {"rewrites": [
        {"bullet_id": "b2", "new_text": "Cut mapping API calls 75% with a batching Python service", "sources": ["b2"],
         "why": "scale"},
        {"bullet_id": "b5", "new_text": "Handled backend tasks and code reviews with the routing team", "sources": ["b5"],
         "why": "vague"}]}
    second = {"rewrites": [
        {"bullet_id": "b2", "new_text": "Cut mapping API calls from 12,000 to 3,000 per day with a batching Python service",
         "sources": ["b2"], "why": "scale"}]}
    p = FakeProvider().reply("rewrite", first).reply("rewrite_retry", second)
    out, stats, summary = rewrite(p, ctx, "posting", [FLAG], [], FactsBank())
    assert len(out) == 16, "one entry per target line"
    assert summary.retried and summary.changed == 2
    b2 = next(r for r in out if r.bullet_id == "b2")
    assert b2.status == OK, b2.reasons
    assert "12,000 to 3,000" in b2.new_text
    assert len(stats) == 2
    assert stats[0].blocked_claims == 1, "the invented 75% is counted before blocking"
    assert stats[0].blocked_by_kind == {"number": 1}
    assert p.call_count("rewrite_retry") == 1
    retry_user = p.calls[1].user
    assert "[b2]" in retry_user and "[b5] (" not in retry_user
    assert "were blocked by the checker" in retry_user


def test_still_blocked_after_retry_stays_blocked(ctx):
    bad = {"rewrites": [{"bullet_id": "b2", "new_text": "Saved Northwind $1M with Rust", "sources": ["b2"], "why": ""}]}
    p = FakeProvider().reply("rewrite", bad).reply("rewrite_retry", bad)
    out, _, summary = rewrite(p, ctx, "posting", [], [], FactsBank())
    assert next(r for r in out if r.bullet_id == "b2").status == BLOCKED
    assert summary.blocked == 1
    assert summary.message.startswith("1 rewrite was blocked because the sources don't back up every claim.")
    assert 'Skill "Rust" is not in the cited sources.' in summary.message


def test_failed_retry_keeps_first_result(ctx):
    bad = {"rewrites": [{"bullet_id": "b2", "new_text": "Saved $1M", "sources": ["b2"], "why": ""}]}
    p = FakeProvider().reply("rewrite", bad).fail("rewrite_retry", ServerError())
    out, stats, summary = rewrite(p, ctx, "posting", [], [], FactsBank())
    assert next(r for r in out if r.bullet_id == "b2").status == BLOCKED and len(stats) == 1
    assert summary.retry_error and "The second try failed" in summary.message


# -- Done ---------------------------------------------------------------------------


def test_done_scores_both_resumes_in_one_call(ctx):
    accepted = "Made a Discord bot that tracks roommate expenses and posts a weekly summary"
    provider = FakeProvider().reply("rescore", {"base_ats_score": 58, "tailored_ats_score": 71})
    result, stats = rescore(provider, ctx, "posting", {"b10": accepted, "b5": ""})
    assert provider.call_count("rescore") == 1, "one call, so both scores come from the same reading"
    assert (result.before, result.after) == (58, 71)
    user = provider.calls[0].user
    resume_a = user.split("<resume_a>\n", 1)[1].split("</resume_a>", 1)[0]
    resume_b = user.split("<resume_b>\n", 1)[1].split("</resume_b>", 1)[0]
    assert accepted not in resume_a and f"- {accepted}" in resume_b
    assert "Worked with the team" in resume_a and "Worked with the team" not in resume_b, "a removed bullet is gone"
    assert result.scored == {"b10": accepted, "b5": ""}
    assert stats.step == "rescore"


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
    found, _ = score(demo, ctx, "", POSTING)
    assert len(found.red_flags) == 3
    out, _, _ = rewrite(demo, ctx, POSTING, found.red_flags, [], FactsBank())
    changed = [r for r in out if r.status != UNCHANGED]
    assert len(changed) == 2, "only the two vague bullets change"
    for r in changed:
        assert r.status == OK, r.reasons
    final, _ = rescore(demo, ctx, POSTING, {r.bullet_id: r.new_text for r in changed})
    assert final.after > final.before, "the vague openers were replaced"
    assert final.before == found.ats, "the same count as Score"
    tex = ctx.doc.apply(export_edits(ctx.doc, {r.bullet_id: r.new_text for r in changed}, [],
                                     skills.extract_posting_skills(POSTING)))
    assert "Worked alongside the team" in tex
