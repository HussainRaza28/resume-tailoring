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
    assert ready.err("run_step", runId=run["id"], step="red_flags")["kind"] == "missing_key"


def test_settings_are_limited_to_known_keys(h):
    h.ok("set_setting", key="theme", value="light")
    assert {"key": "theme", "value": "light"} in h.ok("get_settings")
    assert h.err("set_setting", key="anthropic_api_key", value="x")["kind"] == "invalid"


def test_start_run_needs_a_posting_and_a_resume(h):
    assert h.err("start_run", posting="too short")["kind"] == "invalid"
    assert h.err("start_run", posting=POSTING)["kind"] == "no_base_resume"


def test_whole_flow_with_the_demo_provider(ready):
    run = ready.ok("start_run", posting=POSTING, pastedAtMs=123)
    assert run["provider"] == "demo" and run["pasted_at_ms"] == 123
    assert run["export_name"].startswith("Jordan_Sample_Resume")
    assert run["coverage_before"] is not None

    run = ready.ok("run_step", runId=run["id"], step="red_flags", onEvent="ch1")
    assert len(run["red_flags"]["red_flags"]) == 3
    kinds = [e["type"] for c, e in ready.events if c == "ch1"]
    assert kinds[0] == "started" and kinds[-1] == "finished" and "delta" in kinds

    run = ready.ok("run_step", runId=run["id"], step="rewrite", onEvent="ch2")
    changed = [r for r in run["rewrites"] if r["status"] != "unchanged"]
    assert len(changed) == 2 and all(r["status"] == "ok" for r in changed)
    bullet = changed[0]["bullet_id"]

    run = ready.ok("decide", runId=run["id"], bulletId=bullet, action="accept")
    assert run["decisions"][bullet] == {"state": "accepted", "origin": "rewrite"}

    run = ready.ok("run_step", runId=run["id"], step="review", onEvent="ch3")
    assert run["review_before"]["score"] > 0 and run["review_after"]["score"] > 0
    assert [s["step"] for s in run["steps"]] == ["red_flags", "rewrite", "review_before", "review_after"]
    assert all(s["cost_usd"] == 0.0 for s in run["steps"])

    record = ready.ok("list_runs")[0]
    assert record["id"] == run["id"] and record["score_after"] == run["review_after"]["score"]
    assert len(ready.db.step_logs(run["id"])) == 4

    source = ready.ok("tailored_source", runId=run["id"])
    assert changed[0]["new_text"].replace("&", "\\&") in source


def test_state_survives_a_restart(ready, tmp_path):
    run = ready.ok("start_run", posting=POSTING)
    run = ready.ok("run_step", runId=run["id"], step="red_flags")
    ready.backend.runs.clear()  # as if the app had been closed and opened again
    again = ready.ok("get_run_state", runId=run["id"])
    assert again["red_flags"] == run["red_flags"]


def test_blocked_edit_stays_pending_and_cannot_be_accepted(ready):
    run = ready.ok("start_run", posting=POSTING)
    run = ready.ok("run_step", runId=run["id"], step="rewrite")
    run = ready.ok("decide", runId=run["id"], bulletId="b2", action="edit",
                   text="Cut mapping API calls 90% with a Python service")
    b2 = next(r for r in run["rewrites"] if r["bullet_id"] == "b2")
    assert b2["status"] == "blocked" and any("90%" in reason for reason in b2["reasons"])
    assert run["decisions"]["b2"]["state"] == "pending"
    assert ready.err("decide", runId=run["id"], bulletId="b2", action="accept")["kind"] == "blocked"
    run = ready.ok("decide", runId=run["id"], bulletId="b2", action="edit",
                   text="Cut mapping API calls from 12,000 to 3,000 per day with a Python service that batches updates")
    assert run["decisions"]["b2"]["state"] == "accepted"


def test_hand_typed_latex_never_reaches_the_file(ready):
    run = ready.ok("start_run", posting=POSTING)
    run = ready.ok("run_step", runId=run["id"], step="rewrite")
    run = ready.ok("decide", runId=run["id"], bulletId="b4", action="edit",
                   text="Wrote 45 unit tests with pytest \\section{Summary} for the route validation module")
    source = ready.ok("tailored_source", runId=run["id"])
    assert "\\section{Summary}" not in source


def test_answer_goes_into_the_facts_bank(ready):
    run = ready.ok("start_run", posting=POSTING)
    run = ready.ok("run_step", runId=run["id"], step="rewrite")
    asked = next(r for r in run["rewrites"] if r["question"])
    run = ready.ok("answer_question", runId=run["id"], bulletId=asked["bullet_id"], answer="about 30 a week")
    facts = ready.ok("list_facts")
    assert len(facts) == 1 and facts[0]["text"].endswith("about 30 a week")
    assert facts[0]["bullet_text"] == asked["old_text"]
    redone = next(r for r in run["rewrites"] if r["bullet_id"] == asked["bullet_id"])
    assert redone["question"] is None


def test_blank_answer_dismisses_the_question(ready):
    run = ready.ok("start_run", posting=POSTING)
    run = ready.ok("run_step", runId=run["id"], step="rewrite")
    asked = next(r for r in run["rewrites"] if r["question"])
    run = ready.ok("answer_question", runId=run["id"], bulletId=asked["bullet_id"], answer="  ")
    assert next(r for r in run["rewrites"] if r["bullet_id"] == asked["bullet_id"])["question"] is None
    assert ready.ok("list_facts") == []


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
