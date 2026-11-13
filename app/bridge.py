"""The functions the interface can call.

pywebview exposes one object to the page: ``Bridge``. It has a single public
method, ``call(command, args)``, which looks the command up in ``COMMANDS``,
runs it, and answers ``{"ok": result}`` or ``{"error": {"kind", "message"}}``.
Keeping one entry point means one place for argument names and error
handling, and nothing else on the object can be reached from the page.

Each command is a method on ``Backend``, named after the command. pywebview
runs every call on its own thread, so a slow step doesn't freeze the window.

A run's state lives in memory while the app is open and is saved to SQLite
after every change, so the history list can reopen any run.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from app.core import compile as compiler
from app.core import pricing, skills
from app.core.db import Application, Db, DbError, RunRecord, StepLog
from app.core.export import export_file_name, person_name
from app.core.facts import FactsBank, FactsError
from app.core.pipeline import (
    BLOCKED,
    OK,
    UNCHANGED,
    CheckedRewrite,
    Context,
    Review,
    StepStats,
    TrimHint,
    coverage_for,
    export_edits,
    red_flags,
    review,
    rewrite,
    trim_hints,
)
from app.core.schemas import Proposal, RedFlagsReply
from app.core.secrets import KEY_NAMES, SecretError, SecretStore, mask
from app.core.skills import Coverage, PostingSkills
from app.core.tex import TexDoc, TexError, read_tex
from app.providers import claude_code
from app.providers.base import Provider, ProviderError, Usage
from app.providers.claude_api import ClaudeApiProvider
from app.providers.claude_code import ClaudeCodeProvider
from app.providers.demo import DemoProvider
from app.providers.gemini import GeminiProvider
from app.providers.ollama import DEFAULT_HOST, OllamaProvider

log = logging.getLogger(__name__)

APP_NAME = "Tailor"
APP_VERSION = "0.1.0"

DEFAULT_PROVIDER = "claude_code"
DEFAULT_MODELS = {
    "claude_api": "claude-sonnet-5-5",
    "claude_code": "sonnet",
    "gemini": "gemini-flash-latest",
    "demo": "demo",
}

# Settings the interface may read and write. Keys are not settings: they live in the keychain.
SETTING_KEYS = (
    "provider",
    "model.claude_api",
    "model.claude_code",
    "model.gemini",
    "model.ollama",
    "model.demo",
    "effort",
    "theme",
    "export_dir",
    "ollama_host",
)

NO_BASE_RESUME = "Choose your base resume .tex file first."


class AppError(Exception):
    """An error with a short ``kind`` the interface can act on, and a message for the user."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


# ---------------------------------------------------------------------------
# Run state
# ---------------------------------------------------------------------------


class Decision(BaseModel):
    state: str = "pending"  # pending, accepted or rejected
    # Where accepted text came from: "rewrite" or "review".
    origin: str = ""


class StepRecord(StepStats):
    cost_usd: float | None = None


class ErrorInfo(BaseModel):
    kind: str
    message: str


class RunState(BaseModel):
    id: str
    created_at: str
    company: str = ""
    role: str = ""
    posting: str
    provider: str
    model: str
    pasted_at_ms: int | None = None
    exported_at_ms: int | None = None
    red_flags: RedFlagsReply | None = None
    rewrites: list[CheckedRewrite] = []
    decisions: dict[str, Decision] = {}
    removed: list[str] = []
    review_before: Review | None = None
    review_after: Review | None = None
    posting_skills: PostingSkills = PostingSkills()
    coverage_before: Coverage | None = None
    coverage_after: Coverage | None = None
    steps: list[StepRecord] = []
    pages: int | None = None
    trim_hints: list[TrimHint] = []
    exported_path: str | None = None
    export_name: str = ""
    error: ErrorInfo | None = None

    def accepted(self) -> dict[str, str]:
        """Bullet id to text, for every accepted change."""
        return {
            r.bullet_id: r.new_text
            for r in self.rewrites
            if self.decisions.get(r.bullet_id, Decision()).state == "accepted"
        }

    def current(self) -> dict[str, str]:
        """Accepted texts, plus removed bullets as empty strings."""
        out = self.accepted()
        for bullet_id in self.removed:
            out[bullet_id] = ""
        return out

    def usage(self) -> Usage:
        total = Usage()
        for s in self.steps:
            total.add(s.usage)
        return total

    def cost(self) -> float:
        return sum(s.cost_usd or 0.0 for s in self.steps)


def now_ms() -> int:
    return int(time.time() * 1000)


def guess_company(posting: str) -> str:
    """A first guess at the company from the posting.

    The user can edit it, and the red flags step fills it in from the model when
    it's still empty.
    """
    patterns = [
        r"(?m)^\s*About\s+([A-Z][\w&.\- ]{1,40}?)\s*:?\s*$",
        r"\b(?:at|join)\s+([A-Z][\w&.\-]+(?:\s+[A-Z][\w&.\-]+){0,3})(?:,|\.|!|\s+(?:we|is|are|as|you|and)\b)",
        r"\b([A-Z][\w&.\-]+(?:\s+[A-Z][\w&.\-]+){0,3})\s+is\s+(?:hiring|looking|seeking)\b",
    ]
    for pattern in patterns:
        m = re.search(pattern, posting)
        if m:
            name = m.group(1).strip().rstrip(".")
            if name not in ("Us", "The Role", "You", "The Team", "This Role"):
                return name
    return ""


def app_support_dir() -> Path:
    """The OS's folder for app data: Application Support on a Mac, AppData on Windows."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / APP_NAME


def location_file() -> Path:
    """Records a data folder the user chose. It sits outside the data folder, so it can be found first."""
    return app_support_dir() / "location.json"


def default_data_dir(location: Path | None = None) -> Path:
    """Where private data lives.

    In order: ``TAILOR_DATA_DIR`` if set (for development), the folder chosen in
    Settings, then ``private`` in the OS app-data folder.
    """
    override = os.environ.get("TAILOR_DATA_DIR")
    if override:
        return Path(override)
    location = location or location_file()
    try:
        chosen = json.loads(location.read_text(encoding="utf-8")).get("data_dir")
        if chosen:
            return Path(chosen)
    except (OSError, ValueError):
        pass
    return app_support_dir() / "private"


# ---------------------------------------------------------------------------
# The commands
# ---------------------------------------------------------------------------

# Sends one streamed event to a channel the page opened.
Emit = Callable[[str, dict], None]


class Backend:
    def __init__(
        self,
        data_dir: Path,
        db: Db,
        secrets: SecretStore,
        emit: Emit = lambda _channel, _event: None,
        window: Any = None,
        location: Path | None = None,
    ) -> None:
        self.data_dir = Path(data_dir)
        # Where a data folder chosen in Settings is recorded; None turns that off (tests).
        self.location = location
        self.db = db
        self.secrets = secrets
        self.emit = emit
        self.window = window
        # Open runs by id. Saved to the database after every change.
        self.runs: dict[str, RunState] = {}
        # One change to a run at a time, so a slow step can't overwrite a
        # decision made while it ran.
        self.run_lock = threading.RLock()

    # -- paths and shared helpers --------------------------------------------

    @property
    def base_resume_path(self) -> Path:
        return self.data_dir / "base_resume.tex"

    @property
    def facts_path(self) -> Path:
        return self.data_dir / "facts.json"

    def _base_tex(self) -> str:
        try:
            return read_tex(self.base_resume_path)
        except FileNotFoundError as e:
            raise AppError("no_base_resume", NO_BASE_RESUME) from e

    def _run_tex(self, run_id: str) -> str:
        """The base resume a run started from (the current one for older runs)."""
        return self.db.run_base_tex(run_id) or self._base_tex()

    def _run_context(self, run_id: str) -> Context:
        return Context(self._run_tex(run_id))

    def _facts(self) -> FactsBank:
        return FactsBank.load(self.facts_path)

    def _tectonic(self) -> Path:
        found = compiler.find_tectonic()
        if found is None:
            raise compiler.TectonicMissing()
        return found

    def _setting(self, key: str) -> str | None:
        return self.db.get_setting(key)

    def _key(self, provider: str) -> str:
        key = self.secrets.get(KEY_NAMES[provider])
        if not key or not key.strip():
            raise AppError("missing_key", "No API key is saved for this provider. Add one in Settings.")
        return key.strip()

    def _provider(self, provider: str, model: str) -> Provider:
        """Build the provider a run uses."""
        effort = self._setting("effort") or None
        if provider == "demo":
            return DemoProvider()
        if provider == "claude_api":
            return ClaudeApiProvider(self._key("claude_api"), model=model, effort=effort)
        if provider == "claude_code":
            return ClaudeCodeProvider(model=model, effort=effort)
        if provider == "gemini":
            return GeminiProvider(self._key("gemini"), model=model)
        if provider == "ollama":
            return OllamaProvider(model, host=self._setting("ollama_host") or DEFAULT_HOST)
        raise AppError("missing_provider", f"Unknown provider {provider}.")

    def _resolve_provider(self, provider: str | None, model: str | None) -> tuple[str, str]:
        """The provider and model for a new run: the choice made, else Settings, else the defaults."""
        provider = provider or self._setting("provider") or DEFAULT_PROVIDER
        model = model or self._setting(f"model.{provider}") or DEFAULT_MODELS.get(provider, "")
        if not model:
            raise AppError("invalid", "Pick a model for this provider in Settings.")
        return provider, model

    # -- run storage ---------------------------------------------------------

    def _get_run(self, run_id: str) -> RunState:
        if run_id in self.runs:
            return self.runs[run_id].model_copy(deep=True)
        stored = self.db.run_state(run_id)
        if stored is None:
            raise AppError("not_found", "That run no longer exists.")
        run = RunState.model_validate_json(stored[1])
        self.runs[run_id] = run
        return run.model_copy(deep=True)

    def _save_run(self, run: RunState, tailored_tex: str | None = None) -> RunState:
        """Keep the run in memory and save it: the full state, plus the summary columns."""
        try:
            run.export_name = export_file_name(person_name(self._run_tex(run.id)), run.company)
        except AppError:
            run.export_name = export_file_name("", run.company)
        self.runs[run.id] = run.model_copy(deep=True)
        record = self.db.get_run(run.id) or RunRecord(id=run.id)
        usage = run.usage()
        status = "exported" if run.exported_at_ms else "failed" if run.error else "running"
        record = record.model_copy(update={
            "company": run.company,
            "role": run.role,
            "provider": run.provider,
            "model": run.model,
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "cache_read_tokens": usage.cache_read_tokens,
            "cache_write_tokens": usage.cache_write_tokens,
            "cost_usd": run.cost(),
            "score_before": run.review_before.score if run.review_before else None,
            "score_after": run.review_after.score if run.review_after else None,
            "coverage_before": run.coverage_before.required_pct() if run.coverage_before else None,
            "coverage_after": run.coverage_after.required_pct() if run.coverage_after else None,
            "blocked_claims": sum(s.blocked_claims for s in run.steps),
            "style_violations": sum(s.style_violations for s in run.steps),
            "pages": run.pages,
            "exported_at_ms": run.exported_at_ms,
            "error_kind": run.error.kind if run.error else None,
            "status": status,
        })
        self.db.update_run(record)
        self.db.save_run_state(run.id, run.model_dump_json(), tailored_tex)
        return run

    def _change_run(self, run_id: str, change: Callable[[RunState], None], tailored_tex: str | None = None) -> RunState:
        """Apply a change to the latest saved state of a run, then save it.

        Slow commands (compiles, model calls) use this instead of saving the
        copy they loaded at the start, so a decision made meanwhile isn't lost.
        """
        with self.run_lock:
            run = self._get_run(run_id)
            change(run)
            return self._save_run(run, tailored_tex)

    def _record_step(self, run: RunState, stats: StepStats, ok: bool = True, error_kind: str | None = None) -> None:
        cost = pricing.cost(run.provider, stats.model or run.model, stats.usage)
        self.db.log_step(
            StepLog(
                run_id=run.id,
                step=stats.step,
                provider=run.provider,
                model=stats.model or run.model,
                duration_ms=stats.duration_ms,
                input_tokens=stats.usage.input_tokens,
                output_tokens=stats.usage.output_tokens,
                cache_read_tokens=stats.usage.cache_read_tokens,
                cache_write_tokens=stats.usage.cache_write_tokens,
                cost_usd=cost or 0.0,
                ok=ok,
                error_kind=error_kind,
            )
        )
        run.steps.append(StepRecord(**stats.model_dump(), cost_usd=cost))

    def _log_blocks(self, run: RunState, checked: list[CheckedRewrite]) -> None:
        for r in checked:
            for claim in r.grounding.unsupported():
                self.db.log_grounding_block(run.id, run.provider, run.model, r.bullet_id, claim.text, claim.kind)

    @staticmethod
    def _recompute_coverage(run: RunState, ctx: Context, facts: FactsBank) -> None:
        run.coverage_before = coverage_for(ctx, run.posting_skills, {}, facts)
        run.coverage_after = coverage_for(ctx, run.posting_skills, run.current(), facts)

    def _sink(self, channel: str | None, step: str) -> Callable[[str], None]:
        """Send streamed text for a step to the page."""
        if not channel:
            return lambda _text: None
        return lambda text: self.emit(channel, {"type": "delta", "step": step, "text": text})

    def _tailored_tex(self, run: RunState) -> str:
        doc = TexDoc.parse(self._run_tex(run.id))
        return doc.apply(export_edits(doc, run.accepted(), run.removed, run.posting_skills))

    # -- app, keys and base resume -------------------------------------------

    def app_info(self) -> dict:
        tectonic = compiler.find_tectonic()
        return {
            "name": APP_NAME,
            "version": APP_VERSION,
            "data_dir": str(self.data_dir),
            "has_base_resume": self.base_resume_path.is_file(),
            "tectonic_path": str(tectonic) if tectonic else None,
        }

    def _key_name(self, provider: str) -> str:
        if provider not in KEY_NAMES:
            raise AppError("invalid", f"{provider} does not use an API key.")
        return KEY_NAMES[provider]

    def key_status(self, provider: str) -> dict:
        value = self.secrets.get(self._key_name(provider))
        return {"provider": provider, "saved": bool(value), "masked": mask(value) if value else None}

    def save_key(self, provider: str, key: str) -> dict:
        name = self._key_name(provider)
        if not key.strip():
            raise AppError("invalid", "The key is empty.")
        self.secrets.set(name, key.strip())
        return self.key_status(provider)

    def delete_key(self, provider: str) -> None:
        self.secrets.delete(self._key_name(provider))

    def change_data_dir(self, path: str) -> dict:
        """Move private data to another folder and use it from now on.

        A folder that already holds Tailor data is used as it is. Otherwise the
        current data is copied there; the old copy is left alone, so nothing is
        lost if the move goes wrong.
        """
        if os.environ.get("TAILOR_DATA_DIR"):
            raise AppError("invalid", "The data folder is set by TAILOR_DATA_DIR, so it can't be changed here.")
        if self.location is None:
            raise AppError("invalid", "The data folder can't be changed in this mode.")
        target = Path(path)
        if not target.is_dir():
            raise AppError("invalid", "Choose an existing folder.")
        if (target / "tailor.db").exists() or target.resolve() == self.data_dir.resolve():
            new_dir = target
        else:
            # Copy into an empty folder as it is, or into a "Tailor" folder inside a busy one.
            new_dir = target if not any(target.iterdir()) else target / APP_NAME
            with self.db.lock:
                self.db.close()
                try:
                    shutil.copytree(self.data_dir, new_dir, dirs_exist_ok=True)
                except OSError as e:
                    self.db = type(self.db)(self.data_dir / "tailor.db")  # keep using the old folder
                    raise AppError("io", f"Could not copy your data there: {e}") from e
        if new_dir.resolve() != self.data_dir.resolve():
            self.db = type(self.db)(new_dir / "tailor.db")
            self.data_dir = new_dir
            self.runs.clear()
        self.location.parent.mkdir(parents=True, exist_ok=True)
        self.location.write_text(json.dumps({"data_dir": str(self.data_dir)}), encoding="utf-8")
        return self.app_info()

    def show_data_dir(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.reveal(str(self.data_dir))

    def import_base_resume(self, path: str) -> None:
        """Copy a chosen .tex file into the private data folder as the base resume."""
        try:
            tex = read_tex(path)
        except OSError as e:
            raise AppError("io", f"Could not read that file: {e}") from e
        if "\\begin{document}" not in tex:
            raise AppError("invalid", "That file does not look like a LaTeX document.")
        TexDoc.parse(tex)  # a template the app can't read is refused now, not mid-run
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.base_resume_path.write_text(tex, encoding="utf-8", newline="")

    def base_resume_info(self) -> dict:
        tex = self._base_tex()
        doc = TexDoc.parse(tex)
        return {"tex": tex, "bullets": len(doc.bullets()), "sections": doc.sections}

    def compile_base(self) -> dict:
        out = compiler.compile_tex(self._base_tex(), self._tectonic())
        return {"pdf": base64.b64encode(out.pdf).decode(), "pages": out.pages, "duration_ms": out.duration_ms}

    def ollama_models(self) -> list[dict]:
        return OllamaProvider("", host=self._setting("ollama_host") or DEFAULT_HOST).list_models()

    def gemini_models(self) -> list[str]:
        return GeminiProvider(self._key("gemini")).list_models()

    def claude_code_status(self) -> dict:
        return claude_code.status()

    # -- runs ----------------------------------------------------------------

    def start_run(
        self,
        posting: str,
        company: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        pasted_at_ms: int | None = None,
    ) -> RunState:
        if len(posting.strip()) < 40:
            raise AppError("invalid", "Paste the full job posting first.")
        base_tex = self._base_tex()
        ctx = Context(base_tex)
        facts = self._facts()
        provider, model = self._resolve_provider(provider, model)
        run = RunState(
            id=str(uuid.uuid4()),
            created_at=datetime.now(timezone.utc).isoformat(),
            company=(company or "").strip() or guess_company(posting),
            posting=posting.strip(),
            provider=provider,
            model=model,
            pasted_at_ms=pasted_at_ms or now_ms(),
            posting_skills=skills.extract_posting_skills(posting),
        )
        self._recompute_coverage(run, ctx, facts)
        posting_hash = hashlib.sha256(run.posting.encode()).hexdigest()
        self.db.insert_run(
            RunRecord(
                id=run.id,
                created_at=run.created_at,
                company=run.company,
                provider=run.provider,
                model=run.model,
                pasted_at_ms=run.pasted_at_ms,
            ),
            run.posting,
            posting_hash,
            base_tex,
        )
        with self.run_lock:
            return self._save_run(run)

    def get_run_state(self, run_id: str) -> RunState:
        return self._get_run(run_id)

    def update_run_meta(self, run_id: str, company: str, role: str) -> RunState:
        def change(run: RunState) -> None:
            run.company = company.strip()
            run.role = role.strip()

        return self._change_run(run_id, change)

    def run_step(self, run_id: str, step: str, on_event: str | None = None) -> RunState:
        """Run one model step: "red_flags", "rewrite" or "review"."""
        run = self._get_run(run_id)
        ctx = self._run_context(run_id)
        facts = self._facts()
        provider = self._provider(run.provider, run.model)
        if on_event:
            self.emit(on_event, {"type": "started", "step": step})
        sink = self._sink(on_event, step)
        steps_before = len(run.steps)
        updates: dict[str, Any] = {}
        try:
            if step == "red_flags":
                flags, stats = red_flags(provider, ctx, run.company, run.posting, sink)
                self._record_step(run, stats)
                updates = {"red_flags": flags, "company": run.company or flags.company, "role": run.role or flags.role}
            elif step == "rewrite":
                flag_list = run.red_flags.red_flags if run.red_flags else []
                checked, all_stats = rewrite(provider, ctx, run.posting, flag_list, facts, None, sink)
                for stats in all_stats:
                    self._record_step(run, stats)
                self._log_blocks(run, checked)
                updates = {"rewrites": checked, "decisions": {}}
            elif step == "review":
                # Score the base resume and the current one side by side, in parallel.
                with ThreadPoolExecutor(max_workers=2) as pool:
                    before = pool.submit(review, provider, ctx, run.posting, {}, facts, "review_before", sink)
                    after = pool.submit(review, provider, ctx, run.posting, run.current(), facts, "review_after", sink)
                    review_before, stats_before = before.result()
                    review_after, stats_after = after.result()
                self._record_step(run, stats_before)
                self._record_step(run, stats_after)
                self._log_blocks(run, [r for s in review_after.skipped_sections for r in s.rewrites])
                updates = {"review_before": review_before, "review_after": review_after}
            else:
                raise AppError("invalid", f"Unknown step {step}.")
        except ProviderError as e:
            failed = run.model_copy(deep=True)
            self._record_step(failed, StepStats(step=step, model=run.model), ok=False, error_kind=e.kind)
            failed_step = failed.steps[-1]

            def mark_failed(r: RunState) -> None:
                r.steps.append(failed_step)
                r.error = ErrorInfo(kind=e.kind, message=str(e))

            self._change_run(run_id, mark_failed)
            raise
        finally:
            if on_event:
                self.emit(on_event, {"type": "finished", "step": step})

        new_steps = run.steps[steps_before:]

        def apply(r: RunState) -> None:
            for key, value in updates.items():
                setattr(r, key, value)
            r.steps.extend(new_steps)
            r.error = None
            self._recompute_coverage(r, ctx, facts)

        return self._change_run(run_id, apply)

    def decide(self, run_id: str, bullet_id: str, action: str, text: str | None = None) -> RunState:
        """Accept, reject, reset or edit a bullet, or remove and restore it.

        Edited text is checked again. A blocked edit is kept with its reasons
        and stays pending.
        """
        ctx = self._run_context(run_id)
        facts = self._facts()

        def change(run: RunState) -> None:
            index = next((i for i, r in enumerate(run.rewrites) if r.bullet_id == bullet_id), None)
            if index is None:
                raise AppError("not_found", "No rewrite for that bullet.")
            decision = run.decisions.setdefault(bullet_id, Decision())
            current = run.rewrites[index]
            if action == "accept":
                if current.status == BLOCKED:
                    raise AppError("blocked", " ".join(current.reasons))
                decision.state = "accepted"
                decision.origin = decision.origin or "rewrite"
            elif action == "reject":
                decision.state = "rejected"
            elif action == "reset":
                decision.state = "pending"
            elif action == "edit":
                proposal = Proposal(
                    bullet_id=bullet_id, new_text=text or "", sources=current.sources, question=None, why=current.why
                )
                checked = ctx.check(proposal, facts)
                if checked is None:
                    raise AppError("not_found", "Unknown bullet.")
                if checked.status == UNCHANGED:
                    checked.status = OK
                decision.state = "accepted" if checked.status == OK else "pending"
                run.rewrites[index] = checked
            elif action == "remove":
                if bullet_id not in run.removed:
                    run.removed.append(bullet_id)
            elif action == "restore":
                run.removed = [b for b in run.removed if b != bullet_id]
            else:
                raise AppError("invalid", "Unknown action.")
            self._recompute_coverage(run, ctx, facts)

        return self._change_run(run_id, change)

    def toggle_remove(self, run_id: str, bullet_id: str) -> RunState:
        """Remove a bullet that isn't in the rewrite list, or bring it back (for one-page trimming)."""
        ctx = self._run_context(run_id)
        facts = self._facts()

        def change(run: RunState) -> None:
            if bullet_id in run.removed:
                run.removed.remove(bullet_id)
            else:
                run.removed.append(bullet_id)
            self._recompute_coverage(run, ctx, facts)

        return self._change_run(run_id, change)

    def accept_suggestion(self, run_id: str, section: int, bullet_id: str) -> RunState:
        """Accept a rewrite the review suggested. It replaces the bullet's current proposal."""
        ctx = self._run_context(run_id)
        facts = self._facts()

        def change(run: RunState) -> None:
            sections = run.review_after.skipped_sections if run.review_after else []
            suggestion = None
            if 0 <= section < len(sections):
                suggestion = next((r for r in sections[section].rewrites if r.bullet_id == bullet_id), None)
            if suggestion is None:
                raise AppError("not_found", "That suggestion is gone.")
            if suggestion.status == BLOCKED:
                raise AppError("blocked", " ".join(suggestion.reasons))
            suggestion = suggestion.model_copy(deep=True)
            index = next((i for i, r in enumerate(run.rewrites) if r.bullet_id == bullet_id), None)
            if index is None:
                run.rewrites.append(suggestion)
            else:
                suggestion.old_text = run.rewrites[index].old_text
                run.rewrites[index] = suggestion
            run.decisions[bullet_id] = Decision(state="accepted", origin="review")
            self._recompute_coverage(run, ctx, facts)

        return self._change_run(run_id, change)

    def answer_question(self, run_id: str, bullet_id: str, answer: str, on_event: str | None = None) -> RunState:
        """Answer a "How many…?" question.

        A real answer goes into the facts bank and the bullet is rewritten with
        it. A blank answer just dismisses the question.
        """
        run = self._get_run(run_id)
        current = next((r for r in run.rewrites if r.bullet_id == bullet_id), None)
        if current is None:
            raise AppError("not_found", "No rewrite for that bullet.")
        if not answer.strip():

            def dismiss(r: RunState) -> None:
                for item in r.rewrites:
                    if item.bullet_id == bullet_id:
                        item.question = None

            return self._change_run(run_id, dismiss)

        question = current.question or ""
        bank = self._facts()
        bank.add(f"{question.strip()} {answer.strip()}", question, current.old_text)
        bank.save(self.facts_path)

        ctx = self._run_context(run_id)
        provider = self._provider(run.provider, run.model)
        flag_list = run.red_flags.red_flags if run.red_flags else []
        step = "rewrite_one"
        if on_event:
            self.emit(on_event, {"type": "started", "step": step})
        try:
            checked, all_stats = rewrite(
                provider, ctx, run.posting, flag_list, bank, [bullet_id], self._sink(on_event, step)
            )
        finally:
            if on_event:
                self.emit(on_event, {"type": "finished", "step": step})
        self._log_blocks(run, checked)
        before = len(run.steps)
        for stats in all_stats:
            self._record_step(run, stats)
        new_steps = run.steps[before:]

        def apply(r: RunState) -> None:
            r.steps.extend(new_steps)
            if checked:
                fresh = checked[0]
                fresh.question = None
                r.rewrites = [fresh if x.bullet_id == bullet_id else x for x in r.rewrites]
                r.decisions[bullet_id] = Decision()
            self._recompute_coverage(r, ctx, bank)

        return self._change_run(run_id, apply)

    def compile_run(self, run_id: str) -> str:
        """Compile the tailored resume. Returns the PDF, base64-encoded; the page count is saved on the run."""
        run = self._get_run(run_id)
        tex = self._tailored_tex(run)
        out = compiler.compile_tex(tex, self._tectonic())
        doc = TexDoc.parse(self._run_tex(run_id))

        def change(r: RunState) -> None:
            r.pages = out.pages
            r.trim_hints = trim_hints(doc, r.current()) if out.pages > 1 else []

        self._change_run(run_id, change, tailored_tex=tex)
        return base64.b64encode(out.pdf).decode()

    def export_run(self, run_id: str, dir: str) -> RunState:
        """Compile and save the PDF. A result over one page is refused and the trim hints are shown."""
        run = self._get_run(run_id)
        tex = self._tailored_tex(run)
        out = compiler.compile_tex(tex, self._tectonic())
        doc = TexDoc.parse(self._run_tex(run_id))
        if out.pages != 1:

            def too_long(r: RunState) -> None:
                r.pages = out.pages
                r.trim_hints = trim_hints(doc, r.current())

            self._change_run(run_id, too_long, tailored_tex=tex)
            raise AppError("too_long", f"The PDF is {out.pages} pages. Trim a bullet to get back to one page.")

        name = export_file_name(person_name(self._run_tex(run_id)), run.company)
        path = Path(dir) / name
        try:
            path.write_bytes(out.pdf)
        except OSError as e:
            raise AppError("io", f"Could not save the PDF: {e}") from e
        # Keep a private copy of the tailored source and PDF with the run.
        keep = self.data_dir / "outputs" / run.id
        keep.mkdir(parents=True, exist_ok=True)
        (keep / "resume.tex").write_text(tex, encoding="utf-8", newline="")
        (keep / name).write_bytes(out.pdf)
        if self.db.application_for_run(run.id) is None:
            self.db.add_application(run.id, run.company, run.role, date.today().isoformat(), "tailored")

        def exported(r: RunState) -> None:
            r.pages = 1
            r.trim_hints = []
            r.exported_at_ms = r.exported_at_ms or now_ms()
            r.exported_path = str(path)

        return self._change_run(run_id, exported, tailored_tex=tex)

    def tailored_source(self, run_id: str) -> str:
        return self._tailored_tex(self._get_run(run_id))

    # -- history, tracker, facts, baseline, settings -------------------------

    def list_runs(self) -> list[RunRecord]:
        return self.db.list_runs("app", 500)

    def delete_run(self, run_id: str) -> None:
        self.runs.pop(run_id, None)
        application = self.db.application_for_run(run_id)
        if application:
            self.db.delete_application(application.id)
        self.db.delete_run(run_id)
        outputs = self.data_dir / "outputs" / run_id
        for f in outputs.glob("*"):
            f.unlink()
        if outputs.exists():
            outputs.rmdir()

    def list_applications(self) -> list[Application]:
        return self.db.list_applications()

    def add_application(self, company: str, role: str, date: str, status: str) -> int:
        if not company.strip():
            raise AppError("invalid", "Add a company name.")
        return self.db.add_application(None, company.strip(), role.strip(), date, status)

    def update_application(self, application: dict) -> None:
        self.db.update_application(Application(**application))

    def delete_application(self, item_id: int) -> None:
        self.db.delete_application(item_id)

    def list_facts(self) -> list:
        return self._facts().facts

    def save_fact(self, item_id: str | None, text: str) -> list:
        bank = self._facts()
        if item_id:
            if not bank.update(item_id, text):
                raise AppError("invalid", "A fact cannot be empty.")
        elif bank.add(text) is None:
            raise AppError("invalid", "A fact cannot be empty.")
        bank.save(self.facts_path)
        return bank.facts

    def delete_fact(self, item_id: str) -> list:
        bank = self._facts()
        bank.remove(item_id)
        bank.save(self.facts_path)
        return bank.facts

    def list_baseline(self) -> list:
        return self.db.list_baseline()

    def add_baseline(self, duration_ms: int, note: str = "") -> list:
        self.db.add_baseline(int(duration_ms), note)
        return self.db.list_baseline()

    def delete_baseline(self, item_id: int) -> list:
        self.db.delete_baseline(item_id)
        return self.db.list_baseline()

    def get_settings(self) -> list[dict]:
        return [{"key": k, "value": self.db.get_setting(k)} for k in SETTING_KEYS]

    def set_setting(self, key: str, value: str) -> None:
        if key not in SETTING_KEYS:
            raise AppError("invalid", "Unknown setting.")
        self.db.set_setting(key, value)

    # -- native dialogs ------------------------------------------------------

    def pick_folder(self, default_path: str = "") -> str | None:
        if self.window is None:
            return None
        import webview

        picked = self.window.create_file_dialog(webview.FileDialog.FOLDER, directory=default_path or "")
        return picked[0] if picked else None

    def pick_tex_file(self) -> str | None:
        if self.window is None:
            return None
        import webview

        picked = self.window.create_file_dialog(webview.FileDialog.OPEN, file_types=("LaTeX files (*.tex)",))
        return picked[0] if picked else None

    def reveal(self, path: str) -> None:
        """Show a file in Finder or Explorer."""
        if sys.platform == "darwin":
            subprocess.run(["open", "-R", path], check=False)
        elif sys.platform == "win32":
            subprocess.run(["explorer", f"/select,{path}"], check=False)
        else:
            subprocess.run(["xdg-open", str(Path(path).parent)], check=False)


# Every command the page may run. Anything else is refused.
COMMANDS = (
    "app_info", "change_data_dir", "show_data_dir", "key_status", "save_key", "delete_key", "import_base_resume", "base_resume_info",
    "compile_base", "ollama_models", "gemini_models", "claude_code_status",
    "start_run", "get_run_state", "update_run_meta", "run_step", "decide", "toggle_remove",
    "accept_suggestion", "answer_question", "compile_run", "export_run", "tailored_source",
    "list_runs", "delete_run", "list_applications", "add_application", "update_application",
    "delete_application", "list_facts", "save_fact", "delete_fact", "list_baseline", "add_baseline",
    "delete_baseline", "get_settings", "set_setting", "pick_folder", "pick_tex_file", "reveal",
)


def snake_case(name: str) -> str:
    """``runId`` -> ``run_id``. The page sends camelCase names."""
    snake = re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()
    # "id" would hide Python's id(), so the commands call it item_id.
    return "item_id" if snake == "id" else snake


def to_json(value: Any) -> Any:
    """Turn a result into plain JSON data for the page."""
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, list):
        return [to_json(v) for v in value]
    if isinstance(value, dict):
        return {k: to_json(v) for k, v in value.items()}
    return value


def error_reply(e: Exception) -> dict:
    """The ``{kind, message}`` the page gets for an error."""
    if isinstance(e, AppError):
        kind, message = e.kind, e.message
    elif isinstance(e, (ProviderError, compiler.CompileError, TexError)):
        kind, message = e.kind if isinstance(e, ProviderError) else e.code, str(e)
    elif isinstance(e, FactsError):
        kind, message = "facts", str(e)
    elif isinstance(e, DbError):
        kind, message = "db", str(e)
    elif isinstance(e, SecretError):
        kind, message = "keychain", str(e)
    else:
        log.exception("unexpected error in a command")
        kind, message = "unknown", f"Something went wrong: {e}"
    return {"error": {"kind": kind, "message": message}}


class Bridge:
    """The object pywebview exposes to the page. Only ``call`` is public."""

    def __init__(self, backend: Backend) -> None:
        self._backend = backend

    def call(self, command: str, args: dict | None = None) -> dict:
        if command not in COMMANDS:
            return {"error": {"kind": "invalid", "message": f"Unknown command {command}."}}
        kwargs = {snake_case(k): v for k, v in (args or {}).items()}
        try:
            result = getattr(self._backend, command)(**kwargs)
            return {"ok": to_json(result)}
        except Exception as e:  # every error goes back to the page as {kind, message}
            return error_reply(e)


def window_emitter(window: Any) -> Emit:
    """Send streamed events into the page through ``window.__tailorEmit``.

    ``run_js`` doesn't wait for the page to answer, so streaming never holds up a step.
    """

    def emit(channel: str, event: dict) -> None:
        window.run_js(f"window.__tailorEmit && window.__tailorEmit({json.dumps(channel)}, {json.dumps(event)})")

    return emit
