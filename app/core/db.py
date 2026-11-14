"""SQLite storage, with plain SQL through the standard ``sqlite3`` module.

Tables: run history, the application tracker, per-step logs, grounding blocks,
the manual-baseline stopwatch and non-secret settings. The database file lives
in the private data folder and is never committed.

The interface calls the backend from several threads at once, so one
connection is shared and every statement runs under a lock.
"""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel

SCHEMA_VERSION = 3

# Each migration runs once, in order; PRAGMA user_version records how far a file has got.
MIGRATIONS = [
    """
    CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'app',
        company TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        posting_hash TEXT NOT NULL DEFAULT '',
        posting_text TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        pasted_at_ms INTEGER,
        finished_at_ms INTEGER,
        exported_at_ms INTEGER,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        score_before INTEGER,
        score_after INTEGER,
        coverage_before REAL,
        coverage_after REAL,
        blocked_claims INTEGER NOT NULL DEFAULT 0,
        style_violations INTEGER NOT NULL DEFAULT 0,
        pages INTEGER,
        error_kind TEXT,
        state_json TEXT NOT NULL DEFAULT '{}',
        tailored_tex TEXT
    );
    CREATE INDEX runs_created ON runs(created_at);

    CREATE TABLE applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        company TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'tailored'
            CHECK (status IN ('tailored','applied','interview','offer','rejected')),
        notes TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    );

    CREATE TABLE step_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        step TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL,
        error_kind TEXT
    );
    CREATE INDEX step_logs_run ON step_logs(run_id);

    CREATE TABLE grounding_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        bullet_id TEXT NOT NULL,
        claim TEXT NOT NULL,
        claim_kind TEXT NOT NULL,
        created_at TEXT NOT NULL
    );

    CREATE TABLE manual_baseline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """,
    # 2: each run keeps the base resume it started from, so replacing the base
    # resume later can't break an earlier run (its bullet ids point into this copy).
    """
    ALTER TABLE runs ADD COLUMN base_tex TEXT;
    """,
    # 3: an application can keep the link to its posting, for roles marked
    # applied from the Jobs screen.
    """
    ALTER TABLE applications ADD COLUMN url TEXT NOT NULL DEFAULT '';
    """,
]

APP_STATUSES = ("tailored", "applied", "interview", "offer", "rejected")


class DbError(Exception):
    pass


class RunRecord(BaseModel):
    """The summary columns of a run, for the history list and the numbers."""

    id: str
    created_at: str = ""
    source: str = "app"
    company: str = ""
    role: str = ""
    provider: str = ""
    model: str = ""
    status: str = "running"
    pasted_at_ms: int | None = None
    finished_at_ms: int | None = None
    exported_at_ms: int | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost_usd: float = 0.0
    score_before: int | None = None
    score_after: int | None = None
    coverage_before: float | None = None
    coverage_after: float | None = None
    blocked_claims: int = 0
    style_violations: int = 0
    pages: int | None = None
    error_kind: str | None = None


class Application(BaseModel):
    id: int
    run_id: str | None
    company: str
    role: str
    date: str
    status: str
    notes: str
    url: str = ""


class StepLog(BaseModel):
    run_id: str
    step: str
    provider: str
    model: str
    duration_ms: int
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    cost_usd: float = 0.0
    ok: bool
    error_kind: str | None = None


class BaselineEntry(BaseModel):
    id: int
    started_at: str
    duration_ms: int
    note: str


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Db:
    def __init__(self, path: Path | str) -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False because calls arrive on several threads; the
        # lock below makes sure only one statement runs at a time.
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA foreign_keys=ON")
            self._migrate()

    def _migrate(self) -> None:
        version = self.conn.execute("PRAGMA user_version").fetchone()[0]
        for number, sql in enumerate(MIGRATIONS, start=1):
            if version < number:
                self.conn.executescript(sql)
                self.conn.execute(f"PRAGMA user_version = {number}")
        self.conn.commit()

    def schema_version(self) -> int:
        with self.lock:
            return self.conn.execute("PRAGMA user_version").fetchone()[0]

    def _write(self, sql: str, params: tuple | dict = ()) -> int:
        """Run one change and commit it. Returns the new row id for inserts."""
        with self.lock:
            cur = self.conn.execute(sql, params)
            self.conn.commit()
            return cur.lastrowid

    def _rows(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, params).fetchall()

    def close(self) -> None:
        with self.lock:
            self.conn.close()

    # -- runs ----------------------------------------------------------------

    def insert_run(self, run: RunRecord, posting_text: str, posting_hash: str, base_tex: str | None = None) -> None:
        self._write(
            """INSERT INTO runs (id, created_at, source, company, role, posting_hash, posting_text,
                   provider, model, status, pasted_at_ms, base_tex)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                run.id, run.created_at or now(), run.source, run.company, run.role, posting_hash,
                posting_text, run.provider, run.model, run.status, run.pasted_at_ms, base_tex,
            ),
        )

    def run_base_tex(self, run_id: str) -> str | None:
        """The base resume a run started from, or None for a run saved before it was kept."""
        rows = self._rows("SELECT base_tex FROM runs WHERE id=?", (run_id,))
        return rows[0][0] if rows else None

    def update_run(self, run: RunRecord) -> None:
        """Update a run's summary columns."""
        self._write(
            """UPDATE runs SET company=:company, role=:role, status=:status, finished_at_ms=:finished_at_ms,
                   exported_at_ms=:exported_at_ms, input_tokens=:input_tokens, output_tokens=:output_tokens,
                   cache_read_tokens=:cache_read_tokens, cache_write_tokens=:cache_write_tokens,
                   cost_usd=:cost_usd, score_before=:score_before, score_after=:score_after,
                   coverage_before=:coverage_before, coverage_after=:coverage_after,
                   blocked_claims=:blocked_claims, style_violations=:style_violations, pages=:pages,
                   error_kind=:error_kind, provider=:provider, model=:model
               WHERE id=:id""",
            run.model_dump(),
        )

    def save_run_state(self, run_id: str, state_json: str, tailored_tex: str | None = None) -> None:
        """Save a run's full state. The tailored source is kept unless a new one is given."""
        self._write(
            "UPDATE runs SET state_json=?, tailored_tex=COALESCE(?, tailored_tex) WHERE id=?",
            (state_json, tailored_tex, run_id),
        )

    def run_state(self, run_id: str) -> tuple[str, str, str | None] | None:
        """(posting text, state JSON, tailored source) for a run, or None."""
        rows = self._rows("SELECT posting_text, state_json, tailored_tex FROM runs WHERE id=?", (run_id,))
        return (rows[0][0], rows[0][1], rows[0][2]) if rows else None

    @staticmethod
    def _run_record(row: sqlite3.Row) -> RunRecord:
        return RunRecord(**{k: row[k] for k in RunRecord.model_fields})

    def get_run(self, run_id: str) -> RunRecord | None:
        rows = self._rows("SELECT * FROM runs WHERE id=?", (run_id,))
        return self._run_record(rows[0]) if rows else None

    def list_runs(self, source: str | None = "app", limit: int = 500) -> list[RunRecord]:
        rows = self._rows(
            "SELECT * FROM runs WHERE (? IS NULL OR source = ?) ORDER BY created_at DESC LIMIT ?",
            (source, source, limit),
        )
        return [self._run_record(r) for r in rows]

    def delete_run(self, run_id: str) -> None:
        with self.lock:
            self.conn.execute("DELETE FROM step_logs WHERE run_id=?", (run_id,))
            self.conn.execute("DELETE FROM grounding_blocks WHERE run_id=?", (run_id,))
            self.conn.execute("DELETE FROM runs WHERE id=?", (run_id,))
            self.conn.commit()

    # -- step logs and grounding blocks --------------------------------------

    def log_step(self, log: StepLog) -> None:
        self._write(
            """INSERT INTO step_logs (run_id, step, provider, model, started_at, duration_ms, input_tokens,
                   output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, ok, error_kind)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                log.run_id, log.step, log.provider, log.model, now(), log.duration_ms, log.input_tokens,
                log.output_tokens, log.cache_read_tokens, log.cache_write_tokens, log.cost_usd, int(log.ok),
                log.error_kind,
            ),
        )

    def step_logs(self, run_id: str) -> list[StepLog]:
        rows = self._rows(
            """SELECT run_id, step, provider, model, duration_ms, input_tokens, output_tokens,
                   cache_read_tokens, cache_write_tokens, cost_usd, ok, error_kind
               FROM step_logs WHERE run_id=? ORDER BY id""",
            (run_id,),
        )
        return [StepLog(**dict(r)) for r in rows]

    def log_grounding_block(
        self, run_id: str, provider: str, model: str, bullet_id: str, claim: str, claim_kind: str
    ) -> None:
        self._write(
            """INSERT INTO grounding_blocks (run_id, provider, model, bullet_id, claim, claim_kind, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (run_id, provider, model, bullet_id, claim, claim_kind, now()),
        )

    def grounding_block_count(self, run_id: str | None = None) -> int:
        rows = self._rows("SELECT COUNT(*) FROM grounding_blocks WHERE (? IS NULL OR run_id = ?)", (run_id, run_id))
        return rows[0][0]

    # -- applications --------------------------------------------------------

    @staticmethod
    def _check_status(status: str) -> None:
        if status not in APP_STATUSES:
            raise DbError(f"status must be one of {', '.join(APP_STATUSES)}")

    def add_application(
        self, run_id: str | None, company: str, role: str, date: str, status: str, url: str = ""
    ) -> int:
        self._check_status(status)
        return self._write(
            "INSERT INTO applications (run_id, company, role, date, status, url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (run_id, company, role, date, status, url, now()),
        )

    def update_application(self, app: Application) -> None:
        self._check_status(app.status)
        self._write(
            "UPDATE applications SET company=?, role=?, date=?, status=?, notes=?, url=?, updated_at=? WHERE id=?",
            (app.company, app.role, app.date, app.status, app.notes, app.url, now(), app.id),
        )

    def delete_application(self, app_id: int) -> None:
        self._write("DELETE FROM applications WHERE id=?", (app_id,))

    def list_applications(self) -> list[Application]:
        rows = self._rows(
            "SELECT id, run_id, company, role, date, status, notes, url FROM applications ORDER BY date DESC, id DESC"
        )
        return [Application(**dict(r)) for r in rows]

    def application_for_run(self, run_id: str) -> Application | None:
        rows = self._rows(
            "SELECT id, run_id, company, role, date, status, notes, url FROM applications WHERE run_id=?", (run_id,)
        )
        return Application(**dict(rows[0])) if rows else None

    # -- manual baseline -----------------------------------------------------

    def add_baseline(self, duration_ms: int, note: str) -> int:
        if duration_ms <= 0:
            raise DbError("duration must be positive")
        return self._write(
            "INSERT INTO manual_baseline (started_at, duration_ms, note) VALUES (?, ?, ?)", (now(), duration_ms, note)
        )

    def list_baseline(self) -> list[BaselineEntry]:
        rows = self._rows("SELECT id, started_at, duration_ms, note FROM manual_baseline ORDER BY id")
        return [BaselineEntry(**dict(r)) for r in rows]

    def delete_baseline(self, entry_id: int) -> None:
        self._write("DELETE FROM manual_baseline WHERE id=?", (entry_id,))

    # -- settings ------------------------------------------------------------

    def get_setting(self, key: str) -> str | None:
        rows = self._rows("SELECT value FROM settings WHERE key=?", (key,))
        return rows[0][0] if rows else None

    def set_setting(self, key: str, value: str) -> None:
        self._write(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
