"""Tests for the bridge: the commands the interface calls, end to end with the Demo provider."""

import base64
import json
import os
from pathlib import Path

import pytest

from app.bridge import Backend, Bridge, guess_company, snake_case, window_emitter
from app.core.compile import find_tectonic
from app.core.db import Db
from app.core.secrets import MemoryStore

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE = FIXTURES / "sample_resume.tex"
POSTING = (FIXTURES / "sample_posting.txt").read_text(encoding="utf-8")


class Harness:
    """A bridge on a temporary data folder, recording every streamed event."""

    def __init__(self, tmp_path: Path):
        self.events: list[tuple[str, dict]] = []
        self.db = Db(":memory:")
        self.secrets = MemoryStore()
        self.backend = Backend(tmp_path / "private", self.db, self.secrets, emit=lambda c, e: self.events.append((c, e)))
        self.bridge = Bridge(self.backend)

    def ok(self, command, **args):
        reply = self.bridge.call(command, args)
        assert "ok" in reply, reply
        return reply["ok"]

    def err(self, command, **args):
        reply = self.bridge.call(command, args)
        assert "error" in reply, reply
        return reply["error"]


@pytest.fixture
def h(tmp_path):
    harness = Harness(tmp_path)
    yield harness
    harness.db.close()


@pytest.fixture
def ready(h):
    """A bridge with the sample resume imported and the Demo provider selected."""
    h.ok("import_base_resume", path=str(SAMPLE))
    h.ok("set_setting", key="provider", value="demo")
    return h


def test_only_listed_commands_run(h):
    assert h.err("_get_run", runId="x")["kind"] == "invalid"
    assert h.err("__init__")["kind"] == "invalid"
    assert [n for n in dir(h.bridge) if not n.startswith("_")] == ["call"], "only call() is reachable from the page"


def test_argument_names_are_converted():
    assert snake_case("runId") == "run_id"
    assert snake_case("pastedAtMs") == "pasted_at_ms"
    assert snake_case("id") == "item_id"


def test_app_info_and_base_resume(h):
    info = h.ok("app_info")
    assert info["has_base_resume"] is False and info["name"] == "Tailor"
    assert h.err("base_resume_info")["kind"] == "no_base_resume"
    h.ok("import_base_resume", path=str(SAMPLE))
    assert h.ok("app_info")["has_base_resume"] is True
    assert h.ok("base_resume_info")["bullets"] == 11
    copied = Path(h.ok("app_info")["data_dir"]) / "base_resume.tex"
    assert copied.read_bytes() == SAMPLE.read_bytes(), "the base resume is copied byte for byte"


def test_windows_line_endings_are_kept(h, tmp_path):
    crlf = tmp_path / "windows.tex"
    crlf.write_bytes(SAMPLE.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))
    h.ok("import_base_resume", path=str(crlf))
    copied = Path(h.ok("app_info")["data_dir"]) / "base_resume.tex"
    assert copied.read_bytes() == crlf.read_bytes()
    h.ok("set_setting", key="provider", value="demo")
    run = h.ok("start_run", posting=POSTING)
    run = h.ok("run_step", runId=run["id"], step="rewrite")
    run = h.ok("decide", runId=run["id"], bulletId="b5", action="accept")
    source = h.ok("tailored_source", runId=run["id"])
    assert "\r\n" in source and "\n" not in source.replace("\r\n", ""), "every line still ends in CRLF"
    assert "Worked alongside the team" in source


def test_import_refuses_non_latex(h, tmp_path):
    other = tmp_path / "notes.txt"
    other.write_text("just text")
    assert h.err("import_base_resume", path=str(other))["kind"] == "invalid"
    assert h.err("import_base_resume", path=str(tmp_path / "missing.tex"))["kind"] == "io"


def test_keys_are_masked_and_validated(h):
    assert h.ok("key_status", provider="claude_api") == {"provider": "claude_api", "saved": False, "masked": None}
    status = h.ok("save_key", provider="claude_api", key="  sk-ant-api03-abcdefghijkl  ")
    assert status == {"provider": "claude_api", "saved": True, "masked": "sk-ant…ijkl"}
    assert h.secrets.get("anthropic_api_key") == "sk-ant-api03-abcdefghijkl"
    assert h.err("save_key", provider="claude_api", key="  ")["kind"] == "invalid"
    assert h.err("key_status", provider="ollama")["kind"] == "invalid"
    h.ok("delete_key", provider="claude_api")
    assert h.ok("key_status", provider="claude_api")["saved"] is False


def test_missing_key_is_reported_when_a_step_runs(ready):
    ready.ok("set_setting", key="provider", value="claude_api")
    run = ready.ok("start_run", posting=POSTING)
    assert ready.err("run_step", runId=run["id"], step="score")["kind"] == "missing_key"


def test_settings_are_limited_to_known_keys(h):
    h.ok("set_setting", key="theme", value="light")
    assert {"key": "theme", "value": "light"} in h.ok("get_settings")
    assert h.err("set_setting", key="anthropic_api_key", value="x")["kind"] == "invalid"


def test_start_run_needs_a_posting_and_a_resume(h):
    assert h.err("start_run", posting="too short")["kind"] == "invalid"
    assert h.err("start_run", posting=POSTING)["kind"] == "no_base_resume"


def test_whole_flow_with_the_demo_provider(ready):
    run = ready.ok("start_run", posting=POSTING, pastedAtMs=123, postingUrl="https://jobs.example.com/1")
    assert run["provider"] == "demo" and run["pasted_at_ms"] == 123
    assert run["posting_url"] == "https://jobs.example.com/1"
    assert run["export_name"].startswith("Jordan_Sample_Resume")
    assert run["coverage_before"] is not None

    run = ready.ok("run_step", runId=run["id"], step="score", onEvent="ch1")
    assert len(run["score"]["red_flags"]) == 3 and run["score"]["ats"] > 0
    kinds = [e["type"] for c, e in ready.events if c == "ch1"]
    assert kinds[0] == "started" and kinds[-1] == "finished" and "delta" in kinds

    run = ready.ok("run_step", runId=run["id"], step="rewrite", onEvent="ch2")
    changed = [r for r in run["rewrites"] if r["status"] != "unchanged"]
    assert len(changed) == 2 and all(r["status"] == "ok" for r in changed)
    bullet = changed[0]["bullet_id"]

    run = ready.ok("decide", runId=run["id"], bulletId=bullet, action="accept")
    assert run["decisions"][bullet] == {"state": "accepted", "origin": "rewrite"}

    run = ready.ok("run_step", runId=run["id"], step="rescore", onEvent="ch3")
    final = run["final"]
    assert final["after"] > final["before"]
    assert final["scored"] == {bullet: changed[0]["new_text"]}
    assert [s["step"] for s in run["steps"]] == ["score", "rewrite", "rescore"]
    assert all(s["cost_usd"] == 0.0 for s in run["steps"])

    record = ready.ok("list_runs")[0]
    assert record["id"] == run["id"]
    assert (record["score_before"], record["score_after"]) == (final["before"], final["after"])
    assert len(ready.db.step_logs(run["id"])) == 3

    source = ready.ok("tailored_source", runId=run["id"])
    assert changed[0]["new_text"].replace("&", "\\&") in source


def test_score_runs_on_sonnet_even_when_opus_is_chosen(ready, monkeypatch):
    used = []
    real = ready.backend._provider

    def spy(provider, model):
        used.append((provider, model))
        return real("demo", "demo")

    monkeypatch.setattr(ready.backend, "_provider", spy)
    run = ready.ok("start_run", posting=POSTING, provider="claude_api", model="claude-opus-5-5")
    ready.ok("run_step", runId=run["id"], step="score")
    ready.ok("run_step", runId=run["id"], step="rewrite")
    assert used == [("claude_api", "claude-sonnet-5-5"), ("claude_api", "claude-opus-5-5")]


def test_state_survives_a_restart(ready, tmp_path):
    run = ready.ok("start_run", posting=POSTING)
    run = ready.ok("run_step", runId=run["id"], step="score")
    ready.backend.runs.clear()  # as if the app had been closed and opened again
    again = ready.ok("get_run_state", runId=run["id"])
    assert again["score"] == run["score"]


def test_a_new_rewrite_clears_the_old_final_score(ready):
    run = ready.ok("start_run", posting=POSTING)
    run = ready.ok("run_step", runId=run["id"], step="rewrite")
    run = ready.ok("run_step", runId=run["id"], step="rescore")
    assert run["final"] is not None
    run = ready.ok("run_step", runId=run["id"], step="rewrite")
    assert run["final"] is None


def test_the_note_becomes_facts_the_rewrite_and_checker_use(ready):
    run = ready.ok("start_run", posting=POSTING)
    note = "TrailMap also has 12 trail guides using it. ok\nI used Redis to cache route lookups at Northwind Logistics."
    run = ready.ok("add_note", runId=run["id"], note=note)
    facts = ready.ok("list_facts")
    assert [f["text"] for f in facts] == [
        "TrailMap also has 12 trail guides using it", "I used Redis to cache route lookups at Northwind Logistics"]
    assert run["note_fact_ids"] == [f["id"] for f in facts]
    # Redis is now a skill the person has, so coverage counts it.
    assert any(s["skill"] == "Redis" and s["have"] for s in run["coverage_before"]["skills"])

    # The rewrite is sent the note's facts, and the checker accepts a rewrite that cites one.
    rid = run["id"]
    ready.ok("run_step", runId=rid, step="rewrite")
    from app.core.schemas import Proposal

    ctx = ready.backend._run_context(rid)
    bank = ready.backend._facts()
    text = "Built a web app for logging hikes on an interactive map, used by 140 members and 12 trail guides"
    fid = facts[0]["id"]
    assert ctx.check(Proposal(bullet_id="b8", new_text=text, sources=["b8", fid], why=""), bank).status == "ok"


def test_undoing_the_note_removes_its_facts_and_rechecks_rewrites_that_used_them(ready):
    ready.ok("save_fact", id=None, text="Mentored 3 new interns on the routing team")
    run = ready.ok("start_run", posting=POSTING)
    rid = run["id"]
    run = ready.ok("add_note", runId=rid, note="TrailMap also has 12 trail guides using it. Mentored 3 new interns on the routing team.")
    assert len(run["note_fact_ids"]) == 1, "a fact saved before the note isn't counted as the note's"
    fid = run["note_fact_ids"][0]
    run = ready.ok("run_step", runId=rid, step="rewrite")

    # Pretend the rewrite used the note's fact for b8, and the user accepted it.
    from app.core.schemas import Proposal

    backend = ready.backend
    ctx = backend._run_context(rid)
    text = "Built a web app for logging hikes on an interactive map, used by 140 members and 12 trail guides"
    checked = ctx.check(Proposal(bullet_id="b8", new_text=text, sources=["b8", fid], why=""), backend._facts())
    assert checked.status == "ok"

    def use_fact(r):
        r.rewrites = [checked if x.bullet_id == "b8" else x for x in r.rewrites]

    backend._change_run(rid, use_fact)
    ready.ok("decide", runId=rid, bulletId="b8", action="accept")

    run = ready.ok("undo_note", runId=rid)
    assert run["note_fact_ids"] == []
    assert [f["text"] for f in ready.ok("list_facts")] == ["Mentored 3 new interns on the routing team"]
    b8 = next(r for r in run["rewrites"] if r["bullet_id"] == "b8")
    assert b8["status"] == "blocked" and any("12" in reason for reason in b8["reasons"])
    assert run["decisions"]["b8"]["state"] == "pending", "an accepted rewrite that lost its fact goes back to undecided"


def test_runs_saved_by_earlier_versions_still_load():
    from app.bridge import RunState

    first = {
        "id": "r1", "created_at": "2026-11-01T00:00:00+00:00", "posting": "p", "provider": "demo", "model": "demo",
        "red_flags": {"company": "Acme", "role": "Intern", "red_flags": [{"flag": "f", "why": "w", "section": "s"}]},
        "review_before": {"score": 58, "verdict": "before", "skipped_sections": []},
        "review_after": {"score": 54, "verdict": "after", "skipped_sections": []},
    }
    run = RunState.model_validate(first)
    assert run.score.company == "Acme" and run.score.red_flags[0].flag == "f" and run.score.ats == 58
    assert (run.final.before, run.final.after) == (58, 54)

    second = {
        "id": "r2", "created_at": "2026-11-14T00:00:00+00:00", "posting": "p", "provider": "demo", "model": "demo",
        "diagnosis": {"company": "Acme", "role": "Intern", "score": {"ats": 61, "hiring_manager": 54, "overall": 58},
                      "verdict": "v", "red_flags": [{"flag": "f", "why": "w", "section": "s"}],
                      "skipped_sections": [], "missing_keywords": []},
        "rescore": {"base": {"ats": 60, "hiring_manager": 56, "overall": 58},
                    "tailored": {"ats": 70, "hiring_manager": 66, "overall": 68}, "verdict": "", "changes": [],
                    "scored": {"b2": "x"}},
        "rewrites": [],
    }
    run = RunState.model_validate(second)
    assert run.score.ats == 61 and (run.final.before, run.final.after, run.final.scored) == (60, 70, {"b2": "x"})


def test_the_persons_own_edit_is_never_blocked(ready):
    run = ready.ok("start_run", posting=POSTING)
    run = ready.ok("run_step", runId=run["id"], step="rewrite")
    # A number no source has: the person typed it, so it's theirs to put on their resume.
    run = ready.ok("decide", runId=run["id"], bulletId="b2", action="edit",
                   text="Cut mapping API calls 90% with a Python service")
    b2 = next(r for r in run["rewrites"] if r["bullet_id"] == "b2")
    assert b2["status"] == "ok" and b2["reasons"] == []
    assert run["decisions"]["b2"]["state"] == "accepted"


def test_a_rewrite_that_needs_your_ok_can_be_accepted(ready):
    from app.core.pipeline import Context
    from app.core.schemas import Proposal

    run = ready.ok("start_run", posting=POSTING)
    rid = run["id"]
    ready.ok("run_step", runId=rid, step="rewrite")
    # Put a model rewrite the checks flag into the run, as the model would have proposed it.
    backend = ready.backend
    flagged = backend._run_context(rid).check(
        Proposal(bullet_id="b3", new_text="Added PostgreSQL indexes that cut lookups by 75% on 2 million rows", sources=["b3"], why=""),
        backend._facts(),
    )
    assert flagged.status == "blocked"

    def put(r):
        r.rewrites = [flagged if x.bullet_id == "b3" else x for x in r.rewrites]

    backend._change_run(rid, put)
    run = ready.ok("decide", runId=rid, bulletId="b3", action="accept")
    assert run["decisions"]["b3"] == {"state": "accepted", "origin": "your OK"}
    assert "cut lookups by 75\\%" in ready.ok("tailored_source", runId=rid)


def test_any_line_can_be_edited_and_the_edit_undone(ready):
    run = ready.ok("start_run", posting=POSTING)
    rid = run["id"]
    lines = ready.ok("run_lines", runId=rid)
    by_id = {x["id"]: x for x in lines}
    assert by_id["h1.3"]["protected"] and by_id["b1"]["label"] == "Coursework" and by_id["h4.0"]["label"] == "Tech stack"
    # A protected fact, the coursework line and a project's tech stack, by hand.
    ready.ok("edit_line", runId=rid, lineId="h1.3", text="Expected May 2026")
    ready.ok("edit_line", runId=rid, lineId="b1", text="**Relevant Coursework:** Data Structures, Compilers")
    run = ready.ok("edit_line", runId=rid, lineId="h4.0", text="**TrailMap** | *TypeScript, React, Go*")
    assert {k: v["state"] for k, v in run["decisions"].items()} == {"h1.3": "accepted", "b1": "accepted", "h4.0": "accepted"}
    source = ready.ok("tailored_source", runId=rid)
    assert "Expected May 2026" in source and "Compilers" in source and "\\emph{TypeScript, React, Go}" in source
    assert ready.ok("run_lines", runId=rid)[3]["text"] == "Expected May 2026"
    # Keep original undoes it.
    ready.ok("decide", runId=rid, bulletId="h1.3", action="reject")
    assert "Expected May 2027" in ready.ok("tailored_source", runId=rid)


def test_hand_typed_latex_never_reaches_the_file(ready):
    run = ready.ok("start_run", posting=POSTING)
    run = ready.ok("run_step", runId=run["id"], step="rewrite")
    run = ready.ok("decide", runId=run["id"], bulletId="b4", action="edit",
                   text="Wrote 45 unit tests with pytest \\section{Summary} for the route validation module")
    source = ready.ok("tailored_source", runId=run["id"])
    assert "\\section{Summary}" not in source


def test_facts_tracker_and_baseline(h):
    facts = h.ok("save_fact", id=None, text="TrailMap has 140 users")
    fid = facts[0]["id"]
    assert h.ok("save_fact", id=fid, text="TrailMap has 150 users")[0]["text"] == "TrailMap has 150 users"
    assert h.err("save_fact", id=None, text=" ")["kind"] == "invalid"
    assert h.ok("delete_fact", id=fid) == []

    app_id = h.ok("add_application", company="Acme", role="Intern", date="2026-11-13", status="applied")
    apps = h.ok("list_applications")
    assert apps[0]["id"] == app_id
    h.ok("update_application", application={**apps[0], "status": "interview"})
    assert h.ok("list_applications")[0]["status"] == "interview"
    assert h.err("add_application", company=" ", role="", date="2026-11-13", status="applied")["kind"] == "invalid"
    assert h.err("update_application", application={**apps[0], "status": "ghosted"})["kind"] == "db"

    entries = h.ok("add_baseline", durationMs=1_500_000, note="first")
    assert entries[0]["duration_ms"] == 1_500_000
    assert h.ok("delete_baseline", id=entries[0]["id"]) == []


def test_delete_run_removes_its_application(ready):
    run = ready.ok("start_run", posting=POSTING)
    ready.db.add_application(run["id"], "Acme", "Intern", "2026-11-13", "tailored")
    ready.ok("delete_run", runId=run["id"])
    assert ready.ok("list_runs") == [] and ready.ok("list_applications") == []
    assert ready.err("get_run_state", runId=run["id"])["kind"] == "not_found"


def test_guess_company():
    assert guess_company("Software Engineer Intern at Stripe, you will build payments.") == "Stripe"
    assert guess_company("Jane Street is hiring interns for the summer.") == "Jane Street"
    assert guess_company("About Ramp\nWe build cards.") == "Ramp"
    assert guess_company("lowercase only text with no names") == ""


def test_window_emitter_writes_safe_javascript():
    sent = []

    class Window:
        def run_js(self, script):
            sent.append(script)

    window_emitter(Window())("ch1", {"type": "delta", "step": "rewrite", "text": 'He said "hi" </script>'})
    assert sent[0].startswith('window.__tailorEmit && window.__tailorEmit("ch1", ')
    payload = sent[0][len('window.__tailorEmit && window.__tailorEmit("ch1", '):-1]
    assert json.loads(payload)["text"] == 'He said "hi" </script>'


@pytest.fixture
def tectonic():
    found = find_tectonic()
    if found is None:
        if os.environ.get("TAILOR_REQUIRE_TECTONIC") == "1":
            pytest.fail("TAILOR_REQUIRE_TECTONIC=1 but Tectonic was not found")
        pytest.skip("Tectonic not found")
    return found


@pytest.mark.tectonic
def test_compile_and_export_a_one_page_pdf(ready, tectonic, tmp_path):
    base = ready.ok("compile_base")
    assert base["pages"] == 1 and base64.b64decode(base["pdf"]).startswith(b"%PDF")
    run = ready.ok("start_run", posting=POSTING)
    run = ready.ok("run_step", runId=run["id"], step="rewrite")
    accepted = next(r for r in run["rewrites"] if r["status"] == "ok")
    run = ready.ok("decide", runId=run["id"], bulletId=accepted["bullet_id"], action="accept")
    pdf = base64.b64decode(ready.ok("compile_run", runId=run["id"]))
    assert pdf.startswith(b"%PDF")
    out_dir = tmp_path / "exports"
    out_dir.mkdir()
    run = ready.ok("export_run", runId=run["id"], dir=str(out_dir))
    saved = Path(run["exported_path"])
    assert saved.parent == out_dir and saved.name == run["export_name"] and saved.read_bytes().startswith(b"%PDF")
    assert run["pages"] == 1 and run["exported_at_ms"]
    assert ready.ok("list_applications")[0]["status"] == "tailored"
    assert ready.ok("list_runs")[0]["status"] == "exported"


@pytest.mark.tectonic
def test_export_refuses_more_than_one_page(ready, tectonic, tmp_path):
    run = ready.ok("start_run", posting=POSTING)
    run = ready.ok("run_step", runId=run["id"], step="rewrite")
    # Each bullet repeated several times: longer, but every claim is still its own,
    # so the edits pass the checks and only the length is wrong.
    for r in run["rewrites"]:
        if r["section"] in ("Experience", "Projects"):
            padded = " and ".join([r["old_text"]] * 4)
            run = ready.ok("decide", runId=run["id"], bulletId=r["bullet_id"], action="edit", text=padded)
            assert run["decisions"][r["bullet_id"]]["state"] == "accepted"
    error = ready.err("export_run", runId=run["id"], dir=str(tmp_path))
    assert error["kind"] == "too_long"
    run = ready.ok("get_run_state", runId=run["id"])
    assert run["pages"] > 1 and run["trim_hints"], "the user is shown what to cut"
    assert list(tmp_path.glob("*.pdf")) == []


def test_export_keeps_an_earlier_file(ready, tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    existing = out / "Jordan_Sample_Resume_Acme.pdf"
    existing.write_bytes(b"earlier resume")
    run = ready.ok("start_run", posting=POSTING, company="Acme")
    try:
        run = ready.ok("export_run", runId=run["id"], dir=str(out))
    except AssertionError:
        import pytest

        pytest.skip("no TeX compiler here")
    assert existing.read_bytes() == b"earlier resume"
    assert run["exported_path"].endswith("Jordan_Sample_Resume_Acme_v2.pdf")
