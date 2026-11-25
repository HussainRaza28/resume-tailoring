"""The Node.js case: a skill typed into "Anything to add?" reaches the Technical Skills line.

The base resume here has no Node.js. The posting prefers it, and the person
types "add Node.js" before Rewrite. The note has to become a fact, the fact
has to reach the prompt and count as a source in the check, the skills line
has to be a line the rewrite can change, and a reply that changes nothing has
to be retried once with the advice listed, then reported for what it was.
"""

from pathlib import Path

import pytest

from app.core import skills
from app.core.facts import FactsBank
from app.core.pipeline import (
    BLOCKED,
    OK,
    SAME_TEXT,
    UNCHANGED,
    Context,
    coverage_for,
    export_edits,
    rewrite,
    split_note,
)
from app.core.schemas import Proposal, RedFlag
from app.core.tex import TexDoc
from app.providers.base import ServerError
from tests.fake_provider import FakeProvider

FIXTURES = Path(__file__).parent / "fixtures"
# The sample resume without Node.js anywhere.
BASE = (
    (FIXTURES / "sample_resume.tex").read_text(encoding="utf-8")
    .replace("React, Node.js, Express", "React, Express")
    .replace("React, Node.js, PostgreSQL", "React, PostgreSQL")
    .replace("REST API in Node.js", "REST API in Express")
)
POSTING = (FIXTURES / "sample_posting.txt").read_text(encoding="utf-8")
FLAG = RedFlag(flag="No Node.js anywhere", why="The posting prefers it", section="Technical Skills")
FRAMEWORKS = "React, Express, pytest, pandas"


@pytest.fixture
def ctx():
    assert "Node.js" not in BASE
    return Context(BASE)


@pytest.fixture
def noted():
    """The facts bank after the note "add Node.js", and the note's fact ids."""
    bank = FactsBank()
    ids = [bank.add(text) for text in split_note("add Node.js")]
    return bank, ids


def same_text_reply(ctx):
    """What the bug report showed: every line back with its own text and an empty why."""
    return {"rewrites": [{"bullet_id": bid, "new_text": text, "sources": [bid], "why": ""}
                         for bid, _entry, text in ctx.rewrite_targets()]}


def skills_reply(sources):
    return {"rewrites": [{"bullet_id": "s2", "new_text": "React, Node.js, Express, pytest, pandas",
                          "sources": sources, "why": "Shows Node.js from the note"}]}


# -- the note ------------------------------------------------------------------------


def test_a_short_note_naming_a_skill_becomes_a_fact():
    assert split_note("add Node.js") == ["Skills: Node.js"]
    assert split_note("Add Node.js to Technical Skills") == ["Skills: Node.js"]
    assert split_note("please include C# and Docker") == ["Skills: C#, Docker"]
    assert split_note("Node.js, Redis") == ["Node.js, Redis"]
    # Still dropped: a fragment with no fact in it.
    assert split_note("ok\nthanks") == []


# -- the check -----------------------------------------------------------------------


def test_skills_lines_are_lines_the_rewrite_covers(ctx):
    ids = [t[0] for t in ctx.rewrite_targets()]
    assert ids[-3:] == ["s1", "s2", "s3"]
    assert ctx.doc.text("s2") == FRAMEWORKS


def test_a_fact_from_the_note_backs_up_the_skill_without_being_cited(ctx, noted):
    bank, ids = noted
    add = Proposal(bullet_id="s2", new_text="React, Node.js, Express, pytest, pandas", sources=["s2"], why="")
    # Without the note, Node.js isn't backed up by anything.
    blocked = ctx.check(add, bank)
    assert blocked.status == BLOCKED
    assert blocked.reasons == ['Skill "Node.js" is not in the cited sources.']
    # The note's facts count whether or not the model cited them, and the card shows the one used.
    ok = ctx.check(add, bank, ids)
    assert ok.status == OK, ok.reasons
    assert ok.sources == ["s2", ids[0]]
    assert ok.warnings == [], "every skill already on the line is kept"


def test_a_skills_line_may_not_invent_a_skill_or_quietly_lose_one(ctx, noted):
    bank, ids = noted
    invented = ctx.check(Proposal(bullet_id="s2", new_text="React, Node.js, Express, pytest, pandas, Kafka",
                                  sources=["s2"], why=""), bank, ids)
    assert invented.status == BLOCKED and 'Skill "Kafka" is not in the cited sources.' in invented.reasons
    lost = ctx.check(Proposal(bullet_id="s2", new_text="React, Node.js", sources=["s2"], why=""), bank, ids)
    assert lost.status == OK and 'Drops "pytest" from the original.' in lost.warnings
    reordered = ctx.check(Proposal(bullet_id="s2", new_text="pandas, React, Express, pytest", sources=["s2"],
                                   why=""), bank, ids)
    assert reordered.status == UNCHANGED, "export already orders a skills line"


# -- the rewrite step ----------------------------------------------------------------


def test_the_note_reaches_the_prompt(ctx, noted):
    bank, ids = noted
    p = FakeProvider().reply("rewrite", skills_reply(["s2"]))
    rewrite(p, ctx, POSTING, [FLAG], [("Node.js", ids[0])], bank, added=ids)
    user = p.calls[0].user
    assert f"Notes I added for this posting. Each one is true and you may use it; cite its fact id:\n[n1] (fact {ids[0]}) Skills: Node.js" in user
    assert f"[s2] (Technical Skills | Frameworks & Libraries) {FRAMEWORKS}" in user
    assert f"[a2] Show Node.js, backed up by {ids[0]}. Add it to the line where it fits." in user
    assert f"[{ids[0]}] Skills: Node.js" in user.split("<facts_bank>")[1]


def test_the_rewrite_adds_node_js_to_the_skills_line(ctx, noted):
    bank, ids = noted
    p = FakeProvider().reply("rewrite", skills_reply(["s2"]))  # the fact isn't even cited
    out, stats, summary = rewrite(p, ctx, POSTING, [FLAG], [("Node.js", ids[0])], bank, added=ids)
    s2 = next(r for r in out if r.bullet_id == "s2")
    assert s2.status == OK, s2.reasons
    assert s2.entry == "Technical Skills | Frameworks & Libraries"
    assert summary.changed == 1 and not summary.retried
    results = {i.id: i for i in summary.items}
    assert results["a2"].status == "applied" and results["a2"].lines == ["s2"], "the keyword is now shown"
    assert results["n1"].status == "applied" and results["n1"].lines == ["s2"], "the note's fact is used"
    assert results["a1"].status == "couldnt_act" and results["a1"].why == "The model didn't report on this item."
    assert p.call_count("rewrite_retry") == 0

    # Accepted, it's on the page: in the exported file and in the keyword count.
    posting = skills.extract_posting_skills(POSTING)
    tex = ctx.doc.apply(export_edits(ctx.doc, {"s2": s2.new_text}, [], posting))
    line = TexDoc.parse(tex).text("s2")
    assert "Node.js" in line and sorted(line.split(", ")) == sorted(FRAMEWORKS.split(", ") + ["Node.js"])
    before = coverage_for(ctx, posting, {}, bank)
    after = coverage_for(ctx, posting, {"s2": s2.new_text}, bank)
    node = lambda c: next(s for s in c.skills if s.skill == "Node.js")  # noqa: E731
    assert node(before).have and not node(before).covered
    assert node(after).covered


def test_identical_text_is_no_edit_and_is_retried_once_with_the_advice(ctx, noted):
    bank, ids = noted
    p = FakeProvider().reply("rewrite", same_text_reply(ctx)).reply("rewrite_retry", skills_reply([ids[0]]))
    out, stats, summary = rewrite(p, ctx, POSTING, [FLAG], [("Node.js", ids[0])], bank, added=ids)
    assert p.call_count("rewrite_retry") == 1
    retry_user = p.calls[1].user
    assert "returned these lines with the same text, so nothing changed. That counts as a failed attempt" in retry_user
    checklist = retry_user.split("Work through this checklist")[1]
    assert "[a1] No Node.js anywhere (Technical Skills): The posting prefers it" in checklist
    assert f"[a2] Show Node.js, backed up by {ids[0]}. Add it to the line where it fits." in checklist
    assert f"[n1] (fact {ids[0]}) Skills: Node.js" in checklist
    assert "[s2] (Technical Skills | Frameworks & Libraries)" in retry_user
    assert next(r for r in out if r.bullet_id == "s2").status == OK
    assert summary.retried and summary.changed == 1 and len(stats) == 2


def test_nothing_changed_twice_says_so_instead_of_no_changes_needed(ctx, noted):
    bank, ids = noted
    p = FakeProvider().reply("rewrite", same_text_reply(ctx)).reply("rewrite_retry", same_text_reply(ctx))
    out, _, summary = rewrite(p, ctx, POSTING, [FLAG], [("Node.js", ids[0])], bank, added=ids)
    assert all(r.status == UNCHANGED and r.unchanged_reason == SAME_TEXT for r in out)
    assert summary.same_text == len(out) and summary.had_advice
    assert summary.message.startswith("The model returned every line unchanged after a second try with the advice "
                                      "and your notes as a checklist, so there is nothing to review.")
    assert "No changes needed" not in summary.message
    # Every advice item and note still gets a visible result.
    assert [(i.id, i.status) for i in summary.items] == [("a1", "couldnt_act"), ("a2", "couldnt_act"),
                                                         ("n1", "couldnt_act")]


def test_no_changes_needed_only_when_there_was_no_advice(ctx):
    p = FakeProvider().reply("rewrite", same_text_reply(ctx))
    _, stats, summary = rewrite(p, ctx, POSTING, [], [], FactsBank())
    assert p.call_count("rewrite_retry") == 0 and len(stats) == 1
    assert summary.message.startswith("No changes needed")


def test_a_failed_second_try_is_reported(ctx, noted):
    bank, ids = noted
    p = FakeProvider().reply("rewrite", same_text_reply(ctx)).fail("rewrite_retry", ServerError())
    _, _, summary = rewrite(p, ctx, POSTING, [FLAG], [("Node.js", ids[0])], bank, added=ids)
    assert summary.retry_error == "The provider is overloaded or returned a server error."
    assert summary.message.endswith("The second try failed: The provider is overloaded or returned a server error.")


def test_answers_for_ids_that_are_not_lines_are_reported(ctx):
    reply = {"rewrites": [{"bullet_id": "h9.9", "new_text": "x", "sources": [], "why": ""}]}
    _, _, summary = rewrite(FakeProvider().reply("rewrite", reply), ctx, POSTING, [], [], FactsBank())
    assert summary.unknown_ids == ["h9.9"]
    assert "1 answer pointed at lines Tailor can't edit (h9.9)." in summary.message


# -- through the app's bridge --------------------------------------------------------


@pytest.fixture
def app(tmp_path, monkeypatch):
    """The bridge with the base resume (no Node.js) and a scripted provider."""
    from tests.test_bridge import Harness

    h = Harness(tmp_path)
    base = tmp_path / "base.tex"
    base.write_text(BASE, encoding="utf-8")
    h.ok("import_base_resume", path=str(base))
    h.ok("set_setting", key="provider", value="demo")
    h.provider = FakeProvider()
    monkeypatch.setattr(h.backend, "_provider", lambda *_: h.provider)
    yield h
    h.db.close()


def test_the_node_js_note_ends_up_on_the_exported_page(app):
    run = app.ok("start_run", posting=POSTING)
    rid = run["id"]
    run = app.ok("add_note", runId=rid, note="add Node.js")
    assert len(run["note_fact_ids"]) == 1, 'the UI says "Added 1 fact"'
    fid = run["note_fact_ids"][0]
    assert [f["text"] for f in app.ok("list_facts")] == ["Skills: Node.js"]

    ctx = Context(BASE)
    app.provider.reply("rewrite", same_text_reply(ctx)).reply("rewrite_retry", skills_reply(["s2"]))
    run = app.ok("run_step", runId=rid, step="rewrite")
    assert app.provider.call_count("rewrite_retry") == 1
    assert f"[{fid}] Skills: Node.js" in app.provider.calls[0].user
    s2 = next(r for r in run["rewrites"] if r["bullet_id"] == "s2")
    assert s2["status"] == "ok" and fid in s2["sources"]
    assert run["rewrite_summary"]["changed"] == 1 and run["rewrite_summary"]["retried"]

    app.ok("decide", runId=rid, bulletId="s2", action="accept")
    assert "Node.js" in TexDoc.parse(app.ok("tailored_source", runId=rid)).text("s2")


def test_a_failed_rewrite_is_an_error_not_an_empty_result(app):
    rid = app.ok("start_run", posting=POSTING)["id"]
    app.provider.fail("rewrite", ServerError())
    error = app.err("run_step", runId=rid, step="rewrite")
    assert error["kind"] == "server"
    run = app.ok("get_run_state", runId=rid)
    assert run["rewrite_summary"] is None and run["rewrites"] == []
    assert run["error"]["kind"] == "server"
