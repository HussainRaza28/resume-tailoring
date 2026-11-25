"""The whole resume as lines: protected facts, changes asked for in a note, and a result for every item.

The resume here is the sample with a GPA, a graduation date of May 2028 and an
Honors section, so dates, GPA and scholarship numbers are all on the page.
"""

from pathlib import Path

import pytest

from app.core.facts import FactsBank
from app.core.instructions import ASK, parse_instruction
from app.core.lines import COURSEWORK, DATE, HONOR, STACK, SUBTITLE
from app.core.pipeline import BLOCKED, OK, UNCHANGED, Context, rewrite, split_note_parts
from app.core.schemas import RedFlag
from app.core.tex import TexDoc
from tests.fake_provider import FakeProvider

FIXTURES = Path(__file__).parent / "fixtures"
HONORS = r"""%-----------HONORS-----------
\section{Honors and Awards}
  \resumeSubHeadingListStart
    \resumeItem{\textbf{APIA Scholar} $|$ \emph{1 of 634 selected from 12,302 applicants for a national scholarship}}
  \resumeSubHeadingListEnd

%-----------TECHNICAL SKILLS-----------"""
BASE = (
    (FIXTURES / "sample_resume.tex").read_text(encoding="utf-8")
    .replace("Minor in Statistics}{Expected May 2027}", "Minor in Statistics $|$ GPA: 3.25}{Expected May 2028}")
    .replace("%-----------TECHNICAL SKILLS-----------", HONORS)
)
POSTING = (FIXTURES / "sample_posting.txt").read_text(encoding="utf-8")


@pytest.fixture
def ctx():
    return Context(BASE)


def ids_of(ctx, kind):
    return [ln.id for ln in ctx.lines if ln.kind == kind]


def same_text_reply(ctx, **changes):
    """Every line the model may change, with its own text unless ``changes`` gives new text."""
    return {"rewrites": [{"bullet_id": lid, "new_text": changes.get(lid, text), "sources": [lid], "why": ""}
                         for lid, _where, text in ctx.rewrite_targets()]}


# -- the lines ------------------------------------------------------------------------


def test_every_part_of_the_resume_is_a_line(ctx):
    kinds = {ln.id: ln.kind for ln in ctx.lines}
    assert kinds["h1.3"] == DATE and kinds["h1.2"] == SUBTITLE
    assert kinds["b1"] == COURSEWORK and kinds["h4.0"] == STACK
    honor = next(ln for ln in ctx.lines if ln.kind == HONOR)
    assert honor.protected == ["APIA Scholar", "1", "634", "12,302"]
    # The model is sent the prose: bullets, coursework, stacks, honors and skills. Never a date or a name.
    sent = [t[0] for t in ctx.rewrite_targets()]
    assert "b1" in sent and "h4.0" in sent and honor.id in sent and "s2" in sent
    assert "h1.3" not in sent and "h1.2" not in sent and "h2.0" not in sent


# -- protected facts --------------------------------------------------------------------


def test_the_model_changing_a_date_gpa_or_scholarship_number_on_its_own_is_blocked(ctx):
    honor = ids_of(ctx, HONOR)[0]
    reply = same_text_reply(ctx, **{honor: "**APIA Scholar** | *1 of 634 selected from 12,000 applicants for a "
                                           "national scholarship*"})
    reply["rewrites"] += [
        {"bullet_id": "h1.3", "new_text": "Expected May 2027", "sources": ["h1.3"], "why": "sooner"},
        {"bullet_id": "h1.2", "new_text": "Bachelor of Science in Computer Science | Minor in Statistics | GPA: 3.5",
         "sources": ["h1.2"], "why": "rounder"},
    ]
    out, _, summary = rewrite(FakeProvider().reply("rewrite", reply), ctx, POSTING, [], [], FactsBank())
    rows = {r.bullet_id: r for r in out}
    for lid, fact in [("h1.3", "Expected May 2028"), ("h1.2", "Bachelor of Science in Computer Science | Minor in "
                                                                 "Statistics | GPA: 3.25"), (honor, "12,302")]:
        assert rows[lid].status == BLOCKED, lid
        assert any(f'Changes "{fact}", a protected fact' in r for r in rows[lid].reasons), rows[lid].reasons
    assert summary.protected_blocked == 3
    assert "3 changes to a protected fact" in summary.message


def test_rewording_an_honor_without_touching_its_name_or_numbers_is_fine(ctx):
    honor = ids_of(ctx, HONOR)[0]
    reply = same_text_reply(ctx, **{honor: "**APIA Scholar** | *1 of 634 chosen from 12,302 applicants for a "
                                           "national scholarship*"})
    out, _, _ = rewrite(FakeProvider().reply("rewrite", reply), ctx, POSTING, [], [], FactsBank())
    assert next(r for r in out if r.bullet_id == honor).status == OK


# -- changes asked for in a note ------------------------------------------------------------


def test_a_note_that_asks_for_a_change_is_kept_apart_from_facts(ctx):
    facts, asked = split_note_parts("change graduation date to 2027. I mentored 3 new interns.\nadd Node.js", ctx.lines)
    assert asked == ["change graduation date to 2027"]
    assert facts == ["I mentored 3 new interns", "Skills: Node.js"]


def test_change_graduation_date_is_applied_with_the_note_as_its_source(ctx):
    p = FakeProvider().reply("rewrite", same_text_reply(ctx))
    out, _, summary = rewrite(p, ctx, POSTING, [], [], FactsBank(), asked=["change graduation date to 2027"])
    date = next(r for r in out if r.bullet_id == "h1.3")
    assert (date.old_text, date.new_text, date.status) == ("Expected May 2028", "Expected May 2027", OK)
    assert date.asked == "change graduation date to 2027" and "note" in date.sources
    assert date.label == "Graduation date"
    # The model is told it's done and isn't sent the line.
    assert '[h1.3] "Expected May 2028" is now "Expected May 2027"' in p.calls[0].user
    assert [(i.id, i.status, i.lines) for i in summary.items] == [("n1", "applied", ["h1.3"])]
    assert "1 line changed because you asked." in summary.message
    assert "No changes needed" not in summary.message


def test_a_note_edits_a_coursework_line_and_a_tech_stack(ctx):
    notes = ["add Compilers to coursework", "add Docker to the TrailMap stack"]
    reply = same_text_reply(ctx, b1="**Relevant Coursework:** Data Structures, Compilers")  # ignored: the note wins
    out, _, summary = rewrite(FakeProvider().reply("rewrite", reply), ctx, POSTING, [], [], FactsBank(), asked=notes)
    rows = {r.bullet_id: r for r in out}
    assert rows["b1"].new_text == ("**Relevant Coursework:** Data Structures, Operating Systems, Databases, Machine "
                                   "Learning, Computer Networks, Compilers")
    assert rows["h4.0"].new_text == "**TrailMap** | *TypeScript, React, Node.js, PostgreSQL, Docker*"
    assert rows["b1"].status == rows["h4.0"].status == OK
    assert [(i.status, i.lines) for i in summary.items] == [("applied", ["b1"]), ("applied", ["h4.0"])]
    # Both write back to valid LaTeX.
    tex = ctx.doc.apply(__import__("app.core.pipeline", fromlist=["export_edits"]).export_edits(
        ctx.doc, {"b1": rows["b1"].new_text, "h4.0": rows["h4.0"].new_text}, [], None))
    assert "\\textbf{TrailMap} $|$ \\emph{TypeScript, React, Node.js, PostgreSQL, Docker}" in tex
    assert "Computer Networks, Compilers}" in tex


def test_an_ambiguous_note_asks_which_line(ctx):
    found = parse_instruction("n1", "fix my dates", ctx.lines)
    assert found.kind == ASK
    assert found.candidates == ["h1.3", "h2.1", "h3.1", "h4.1", "h5.1"]
    out, _, summary = rewrite(FakeProvider().reply("rewrite", same_text_reply(ctx)), ctx, POSTING, [], [],
                              FactsBank(), asked=["fix my dates"])
    assert all(r.status == UNCHANGED for r in out), "nothing is guessed"
    item = summary.items[0]
    assert item.status == "ask" and item.lines == found.candidates
    assert item.why.startswith('"fix my dates" could mean more than one line. Say which one, and what it should say.')
    assert 'Graduation date (Education | State University): "Expected May 2028"' in item.why
    assert "1 note needs you to say which line." in summary.message


def test_only_what_the_note_names_changes():
    ctx = Context(BASE)
    gpa = parse_instruction("n1", "change GPA to 3.4", ctx.lines)
    assert gpa.line_id == "h1.2"
    assert gpa.new_text == "Bachelor of Science in Computer Science | Minor in Statistics | GPA: 3.4"
    year = parse_instruction("n1", "change graduation date to May 2027", ctx.lines)
    assert year.new_text == "Expected May 2027"
    missing = parse_instruction("n1", "change my Kubernetes certificate to 2026", ctx.lines)
    assert missing.kind == "not_found" and "nothing was changed" in missing.question
    # A fact that happens to start with "set" stays a fact.
    assert parse_instruction("n1", "Set up 20 laptops for a weekly coding club", ctx.lines) is None


# -- a result for every item ---------------------------------------------------------------


def test_advice_with_no_line_to_change_says_why(ctx):
    flags = [RedFlag(flag="No contact links", why="Recruiters want GitHub", section="Header"),
             RedFlag(flag="Vague teamwork bullet", why="Says nothing", section="Experience")]
    reply = same_text_reply(ctx, b5="Reviewed code for the routing team and shipped backend tasks")
    reply["items"] = [{"item_id": "a2", "applied": True, "line_ids": ["b5"], "why": "Made b5 specific"}]
    out, _, summary = rewrite(FakeProvider().reply("rewrite", reply), ctx, POSTING, flags, [], FactsBank())
    header, teamwork = summary.items
    assert header.status == "couldnt_act"
    assert header.why.startswith('There\'s no line in "Header" that the rewrite can change')
    assert (teamwork.status, teamwork.lines, teamwork.why) == ("applied", ["b5"], "Made b5 specific")
    assert "1 item couldn't be acted on; each says why below." in summary.message


# -- through the app ------------------------------------------------------------------------


@pytest.fixture
def app(tmp_path, monkeypatch):
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


def test_change_graduation_date_through_the_app_and_undo_it(app):
    rid = app.ok("start_run", posting=POSTING)["id"]
    run = app.ok("add_note", runId=rid, note="change graduation date to 2027")
    assert run["note_asks"] == ["change graduation date to 2027"] and run["note_fact_ids"] == []
    assert app.ok("list_facts") == [], "a requested change isn't a fact"

    app.provider.reply("rewrite", same_text_reply(Context(BASE)))
    run = app.ok("run_step", runId=rid, step="rewrite")
    date = next(r for r in run["rewrites"] if r["bullet_id"] == "h1.3")
    assert date["asked"] == "change graduation date to 2027" and date["status"] == "ok"
    assert run["decisions"]["h1.3"] == {"state": "accepted", "origin": "note"}, "it starts accepted"
    assert TexDoc.parse(app.ok("tailored_source", runId=rid)).text("h1.3") == "Expected May 2027"

    # Undo on the card keeps the original.
    app.ok("decide", runId=rid, bulletId="h1.3", action="reject")
    assert TexDoc.parse(app.ok("tailored_source", runId=rid)).text("h1.3") == "Expected May 2028"

    # Undo on the note takes the change away altogether.
    app.ok("decide", runId=rid, bulletId="h1.3", action="accept")
    run = app.ok("undo_note", runId=rid)
    assert run["note_asks"] == []
    assert next(r for r in run["rewrites"] if r["bullet_id"] == "h1.3")["status"] == "unchanged"
    assert TexDoc.parse(app.ok("tailored_source", runId=rid)).text("h1.3") == "Expected May 2028"
