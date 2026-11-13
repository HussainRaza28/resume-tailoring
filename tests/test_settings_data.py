"""Tests for the data folder, replacing the base resume, and database upgrades."""

import json
import sqlite3
from pathlib import Path

import pytest

from app.bridge import Backend, Bridge, default_data_dir
from app.core.db import MIGRATIONS, SCHEMA_VERSION, Db, RunRecord
from app.core.secrets import MemoryStore

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE = FIXTURES / "sample_resume.tex"
POSTING = (FIXTURES / "sample_posting.txt").read_text(encoding="utf-8")


def make(tmp_path, location=True):
    data_dir = tmp_path / "data"
    backend = Backend(data_dir, Db(data_dir / "tailor.db"), MemoryStore(),
                      location=tmp_path / "support" / "location.json" if location else None)
    return backend, Bridge(backend)


def ok(bridge, command, **args):
    reply = bridge.call(command, args)
    assert "ok" in reply, reply
    return reply["ok"]


def err(bridge, command, **args):
    reply = bridge.call(command, args)
    assert "error" in reply, reply
    return reply["error"]


@pytest.fixture(autouse=True)
def no_env_override(monkeypatch):
    monkeypatch.delenv("TAILOR_DATA_DIR", raising=False)


def test_replacing_the_base_resume_leaves_earlier_runs_alone(tmp_path):
    backend, bridge = make(tmp_path)
    ok(bridge, "import_base_resume", path=str(SAMPLE))
    ok(bridge, "set_setting", key="provider", value="demo")
    run = ok(bridge, "start_run", posting=POSTING)
    run = ok(bridge, "run_step", runId=run["id"], step="rewrite")

    # A new base resume with fewer bullets: the old run's ids no longer exist in it.
    smaller = SAMPLE.read_text(encoding="utf-8").replace(
        "\\resumeItem{Worked with the team on various backend tasks and helped with code reviews}\n", "")
    replacement = tmp_path / "new.tex"
    replacement.write_text(smaller, encoding="utf-8")
    ok(bridge, "import_base_resume", path=str(replacement))
    assert ok(bridge, "base_resume_info")["bullets"] == 10

    backend.runs.clear()
    source = ok(bridge, "tailored_source", runId=run["id"])
    assert "Worked with the team on various backend tasks" in source, "the run still uses its own resume"
    run = ok(bridge, "decide", runId=run["id"], bulletId="b5", action="accept")
    assert run["decisions"]["b5"]["state"] == "accepted"
    assert "Worked alongside the team" in ok(bridge, "tailored_source", runId=run["id"])


def test_old_database_is_upgraded(tmp_path):
    path = tmp_path / "tailor.db"
    conn = sqlite3.connect(path)
    conn.executescript(MIGRATIONS[0])
    conn.execute("PRAGMA user_version = 1")
    conn.execute("INSERT INTO runs (id, created_at, provider, model) VALUES ('old', '2026-01-01', 'demo', 'demo')")
    conn.commit()
    conn.close()
    db = Db(path)
    assert db.schema_version() == SCHEMA_VERSION == 2
    assert db.get_run("old") is not None, "existing rows survive the upgrade"
    assert db.run_base_tex("old") is None
    db.insert_run(RunRecord(id="new", provider="demo", model="demo"), "p", "h", base_tex="\\documentclass{x}")
    assert db.run_base_tex("new") == "\\documentclass{x}"
    db.close()


def test_moving_data_to_an_empty_folder_copies_it(tmp_path):
    backend, bridge = make(tmp_path)
    ok(bridge, "import_base_resume", path=str(SAMPLE))
    ok(bridge, "save_fact", id=None, text="TrailMap has 140 users")
    ok(bridge, "set_setting", key="theme", value="light")
    target = tmp_path / "Dropbox Folder"
    target.mkdir()
    info = ok(bridge, "change_data_dir", path=str(target))
    assert info["data_dir"] == str(target) and info["has_base_resume"]
    assert ok(bridge, "list_facts")[0]["text"] == "TrailMap has 140 users"
    assert {"key": "theme", "value": "light"} in ok(bridge, "get_settings")
    assert (tmp_path / "data" / "facts.json").exists(), "the old copy is left in place"
    recorded = tmp_path / "support" / "location.json"
    assert json.loads(recorded.read_text())["data_dir"] == str(target)
    assert default_data_dir(recorded) == target, "the choice is used on the next start"


def test_a_busy_folder_gets_a_tailor_folder_inside(tmp_path):
    _, bridge = make(tmp_path)
    ok(bridge, "save_fact", id=None, text="A fact")
    documents = tmp_path / "Documents"
    documents.mkdir()
    (documents / "taxes.pdf").write_text("not ours")
    info = ok(bridge, "change_data_dir", path=str(documents))
    assert info["data_dir"] == str(documents / "Tailor")
    assert (documents / "taxes.pdf").read_text() == "not ours"


def test_a_folder_with_tailor_data_is_used_as_it_is(tmp_path):
    other_backend, other_bridge = make(tmp_path / "other")
    ok(other_bridge, "save_fact", id=None, text="From the other folder")
    other_backend.db.close()
    _, bridge = make(tmp_path)
    ok(bridge, "save_fact", id=None, text="From this folder")
    ok(bridge, "change_data_dir", path=str(tmp_path / "other" / "data"))
    assert [f["text"] for f in ok(bridge, "list_facts")] == ["From the other folder"]


def test_data_folder_rules(tmp_path, monkeypatch):
    _, bridge = make(tmp_path)
    assert err(bridge, "change_data_dir", path=str(tmp_path / "missing"))["kind"] == "invalid"
    monkeypatch.setenv("TAILOR_DATA_DIR", str(tmp_path / "dev"))
    assert err(bridge, "change_data_dir", path=str(tmp_path))["kind"] == "invalid"
    assert default_data_dir(tmp_path / "support" / "location.json") == tmp_path / "dev"
    _, no_location = make(tmp_path / "x", location=False)
    monkeypatch.delenv("TAILOR_DATA_DIR")
    assert err(no_location, "change_data_dir", path=str(tmp_path))["kind"] == "invalid"


def test_unreadable_location_file_falls_back_to_the_default(tmp_path):
    bad = tmp_path / "location.json"
    bad.write_text("{not json")
    assert default_data_dir(bad).name == "private"
