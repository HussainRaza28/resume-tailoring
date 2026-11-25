"""ChatGPT through the Codex command-line tool, signed in with a ChatGPT plan.

Each step runs ``codex exec`` as a child process, so it uses the user's
ChatGPT sign-in instead of API credits. The flags all come from
``codex exec --help`` (checked against codex-cli 0.169.0):

- ``--output-schema FILE`` asks for a final answer that fits the step's schema.
- ``-o FILE`` (``--output-last-message``) writes that final answer to a file,
  which is where the reply is read from.
- ``--json`` prints one JSON event per line. They're used to show the answer
  as it arrives, to count tokens and to report a failed turn.
- ``-s read-only`` and an empty working folder (``-C``) mean the agent can't
  change anything on the computer. A step only needs an answer.
- ``--skip-git-repo-check`` lets it run in that empty folder, and
  ``--ephemeral`` keeps these runs out of the user's session history.
- ``--ignore-user-config`` skips the user's config.toml (and any tools set up
  there). The sign-in still comes from the Codex home folder.

Codex has no separate system prompt flag, so the app's instructions, the
resume and the step's message go in together on standard input, which also
avoids a command-line length limit.

``OPENAI_API_KEY`` and ``CODEX_API_KEY`` are removed from the child's
environment, so Codex uses the ChatGPT sign-in, not an API key.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from app.providers.base import CompletionRequest, DeltaSink, OtherError, Provider, ProviderError, RawReply, Usage
from app.providers.cli_paths import find_command
from app.providers.watchdog import Watchdog

# Empty means Codex's own default model.
DEFAULT_MODEL = ""
TIMEOUT_SECONDS = 600
# Stop the command if it prints nothing for this long. Codex prints an event for each step it takes.
IDLE_SECONDS = 240
# Variables that would make codex bill an API key instead of the ChatGPT plan.
_API_ENV = ("OPENAI_API_KEY", "CODEX_API_KEY")
# What `codex login status` prints for each kind of sign-in.
_CHATGPT = "logged in using chatgpt"
_API_KEY = "api key configured"


class CodexMissing(ProviderError):
    kind = "codex_missing"

    def __init__(self) -> None:
        super().__init__("Codex isn't installed. Install it with `npm install -g @openai/codex`, then run `codex login`.")


class NotSignedIn(ProviderError):
    kind = "not_signed_in"

    def __init__(self, detail: str = "") -> None:
        super().__init__("Codex isn't signed in. Run `codex login` in a terminal and sign in with ChatGPT, then try again.")
        self.detail = detail


def find_codex(configured: str | None = None) -> str | None:
    """Where the ``codex`` command is, or None. See cli_paths for where it looks."""
    return find_command("codex", configured)


def child_env() -> dict[str, str]:
    """This process's environment without the variables that select an API key."""
    return {k: v for k, v in os.environ.items() if k not in _API_ENV}


def _no_window() -> int:
    return subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def status(configured: str | None = None) -> dict:
    """Whether Codex is installed and signed in with ChatGPT, for the Settings screen.

    ``auth_method`` is "chatgpt", "api_key" or None. An API key sign-in counts
    as not signed in, since this provider is meant to use the ChatGPT plan.
    """
    path = find_codex(configured)
    if path is None:
        return {"installed": False, "signed_in": False, "path": None, "version": None, "auth_method": None}
    info: dict = {"installed": True, "signed_in": False, "path": path, "version": None, "auth_method": None}
    try:
        version = subprocess.run(
            [path, "--version"], capture_output=True, text=True, timeout=20, env=child_env(), creationflags=_no_window()
        )
        # "codex-cli 0.169.0"
        info["version"] = version.stdout.strip().split(" ")[-1] or None
        login = subprocess.run(
            [path, "login", "status"],
            capture_output=True, text=True, timeout=20, env=child_env(), creationflags=_no_window(),
        )
        said = (login.stdout + login.stderr).lower()
        if _CHATGPT in said:
            info["auth_method"] = "chatgpt"
            info["signed_in"] = True
        elif _API_KEY in said:
            info["auth_method"] = "api_key"
    except (OSError, subprocess.TimeoutExpired):
        pass
    return info


def prompt_text(request: CompletionRequest) -> str:
    return f"{request.system}\n\n{request.context}\n\n{request.user}\n\nReply with JSON only."


class CodexProvider(Provider):
    kind = "codex"
    label = "ChatGPT (Codex)"

    def __init__(self, model: str = DEFAULT_MODEL, command: str | None = None) -> None:
        super().__init__(model or "codex")
        self.chosen_model = model
        self.command = command

    def _args(self, codex: str, workdir: str, schema_path: str, out_path: str) -> list[str]:
        args = [
            codex,
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-user-config",
            "-s", "read-only",
            "-C", workdir,
            "--output-schema", schema_path,
            "-o", out_path,
        ]
        if self.chosen_model:
            args += ["-m", self.chosen_model]
        return [*args, "-"]  # "-": the prompt comes from standard input

    def _send(self, request: CompletionRequest, on_delta: DeltaSink) -> RawReply:
        codex = find_codex(self.command)
        if codex is None:
            raise CodexMissing()
        # The working folder is empty and separate from the files the app hands over.
        with (
            tempfile.TemporaryDirectory(prefix="tailor-codex-") as workdir,
            tempfile.TemporaryDirectory(prefix="tailor-codex-io-") as io_dir,
            tempfile.TemporaryFile("w+") as errors,
        ):
            schema_path = str(Path(io_dir) / "schema.json")
            out_path = str(Path(io_dir) / "answer.json")
            Path(schema_path).write_text(json.dumps(request.json_schema()), encoding="utf-8")
            try:
                proc = subprocess.Popen(
                    self._args(codex, workdir, schema_path, out_path),
                    cwd=workdir,
                    env=child_env(),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=errors,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    creationflags=_no_window(),
                )
            except FileNotFoundError as e:
                raise CodexMissing() from e
            proc.stdin.write(prompt_text(request))
            proc.stdin.close()
            events = EventLog()
            with Watchdog(proc, TIMEOUT_SECONDS, IDLE_SECONDS) as watchdog:
                for line in proc.stdout:
                    watchdog.alive()
                    events.read(line, on_delta)
                proc.wait()
            if watchdog.fired:
                raise OtherError(watchdog.message("Codex"))
            errors.seek(0)
            stderr = errors.read()
            answer = Path(out_path).read_text(encoding="utf-8") if Path(out_path).is_file() else ""
        return events.reply(proc.returncode, answer, stderr, self.chosen_model or "codex")


class EventLog:
    """What the ``--json`` events said: the usage, and a failure if the turn failed.

    Codex also prints ``error`` events while it retries a connection; those
    aren't failures unless the turn itself fails.
    """

    def __init__(self) -> None:
        self.usage = Usage()
        self.failure: str | None = None
        self.last_error: str | None = None

    def read(self, line: str, on_delta: DeltaSink) -> None:
        line = line.strip()
        if not line:
            return
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return
        kind = event.get("type")
        if kind == "item.completed":
            item = event.get("item") or {}
            if item.get("type") == "agent_message" and item.get("text"):
                on_delta(item["text"])
        elif kind == "turn.completed":
            u = event.get("usage") or {}
            cached = u.get("cached_input_tokens", 0)
            # OpenAI counts cached tokens inside input_tokens; the app keeps them apart.
            self.usage = Usage(
                input_tokens=max(0, u.get("input_tokens", 0) - cached),
                output_tokens=u.get("output_tokens", 0),
                cache_read_tokens=cached,
            )
        elif kind == "turn.failed":
            self.failure = str((event.get("error") or {}).get("message") or "the turn failed")
        elif kind == "error":
            self.last_error = str(event.get("message") or "")

    def reply(self, returncode: int, answer: str, stderr: str, model: str) -> RawReply:
        if self.failure or returncode != 0 or not answer.strip():
            message = self.failure or self.last_error or _last_line(stderr) or "no answer"
            lower = message.lower()
            if any(word in lower for word in ("not logged in", "login", "unauthorized", "401", "sign in")):
                raise NotSignedIn(message)
            raise OtherError(f"Codex failed: {message}")
        return RawReply(text=answer.strip(), usage=self.usage, model=model)


def _last_line(text: str) -> str:
    lines = [line for line in text.strip().splitlines() if line.strip() and "WARNING" not in line]
    return lines[-1] if lines else ""
