"""Tests for SQLite storage."""

import threading

import pytest

from app.core.db import SCHEMA_VERSION, Db, DbError, RunRecord, StepLog


@pytest.fixture
def db():
    d = Db(":memory:")
    yield d
    d.close()


def run(rid="r1"):
    return RunRecord(id=rid, company="Acme", role="SWE Intern", provider="fake", model="fake-1", pasted_at_ms=1000)


def test_migrates_once(tmp_path):
    path = tmp_path / "t.db"
    Db(path).close()
    d = Db(path)
    assert d.schema_version() == SCHEMA_VERSION
    d.close()


def test_reopening_a_file_keeps_data(tmp_path):
    path = tmp_path / "private" / "t.db"
    d = Db(path)
    d.insert_run(run(), "posting", "h")
    d.close()
    d = Db(path)
    assert d.get_run("r1") is not None
    d.close()


def test_run_round_trip_and_update(db):
    db.insert_run(run(), "posting text", "hash")
    r = db.get_run("r1")
    assert r.status == "running" and r.source == "app" and r.created_at
    r.status = "exported"
    r.exported_at_ms = 61_000
    r.cost_usd = 0.0123
    r.score_after = 82
    db.update_run(r)
    back = db.get_run("r1")
    assert (back.status, back.exported_at_ms, back.score_after) == ("exported", 61_000, 82)
    db.save_run_state("r1", '{"step":2}', "\\documentclass")
    assert db.run_state("r1") == ("posting text", '{"step":2}', "\\documentclass")
    db.save_run_state("r1", '{"step":3}')
    assert db.run_state("r1")[2] == "\\documentclass", "the tailored source is kept"
    assert len(db.list_runs("app")) == 1
    assert db.list_runs("batch") == []
    db.delete_run("r1")
    assert db.get_run("r1") is None


def test_applications_enforce_status(db):
    db.insert_run(run(), "p", "h")
    app_id = db.add_application("r1", "Acme", "SWE", "2026-11-13", "tailored")
    with pytest.raises(DbError):
        db.add_application(None, "Acme", "SWE", "2026-11-13", "ghosted")
    a = db.list_applications()[0]
    assert a.id == app_id
    db.update_application(a.model_copy(update={"status": "interview"}))
    assert db.application_for_run("r1").status == "interview"
    with pytest.raises(DbError):
        db.update_application(a.model_copy(update={"status": "bogus"}))
    db.delete_application(app_id)
    assert db.list_applications() == []


def test_step_logs_and_blocks(db):
    db.log_step(StepLog(run_id="r1", step="red_flags", provider="fake", model="fake-1", duration_ms=1200,
                        input_tokens=10, output_tokens=5, cost_usd=0.001, ok=True))
    assert len(db.step_logs("r1")) == 1 and db.step_logs("r1")[0].ok is True
    db.log_grounding_block("r1", "fake", "fake-1", "b1", "40%", "number")
    assert db.grounding_block_count("r1") == 1


def test_baseline_and_settings(db):
    with pytest.raises(DbError):
        db.add_baseline(0, "")
    db.add_baseline(25 * 60_000, "first try")
    assert db.list_baseline()[0].duration_ms == 1_500_000
    assert db.get_setting("provider") is None
    db.set_setting("provider", "claude_api")
    db.set_setting("provider", "gemini")
    assert db.get_setting("provider") == "gemini"


def test_many_threads_can_write(db):
    def write(n):
        for i in range(20):
            db.set_setting(f"k{n}", str(i))

    threads = [threading.Thread(target=write, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert all(db.get_setting(f"k{n}") == "19" for n in range(8))
