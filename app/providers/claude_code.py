"""Claude through the Claude Code command-line tool, signed in with a Claude plan.

Each step runs ``claude`` in print mode (``-p``) as a child process, so it is
billed to the user's Claude subscription instead of API credits. The flags all
come from ``claude --help``:

- ``--output-format stream-json --verbose --include-partial-messages`` streams
  one JSON event per line, including text as it's written. (Print mode refuses
  stream-json without ``--verbose``.)
- ``--json-schema`` asks for structured output that fits the step's schema.
- ``--system-prompt`` replaces Claude Code's own instructions with the app's.
- ``--tools ""`` turns off the built-in tools: a step only needs an answer.
- ``--no-session-persistence`` keeps these runs out of the user's session list.

The prompt goes in on standard input rather than as an argument, so a long
posting can't run into a command-line length limit.

``ANTHROPIC_API_KEY`` and ``ANTHROPIC_AUTH_TOKEN`` are removed from the child's
environment. Either one would make ``claude`` bill an API account instead of
using the plan login.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from app.providers.base import (
    CompletionRequest,
    DeltaSink,
    OtherError,
    Provider,
    ProviderError,
    RawReply,
    Usage,
)
from app.providers.cli_paths import find_command
from app.providers.watchdog import Watchdog, kill_tree

DEFAULT_MODEL = "sonnet"
TIMEOUT_SECONDS = 600
# Stop the command if it prints nothing for this long. Streaming prints a line every few seconds.
IDLE_SECONDS = 240
# Once the answer is in, how long the command gets to exit before it's stopped.
EXIT_GRACE_SECONDS = 10
# Variables that would switch claude from the plan login to an API account.
_API_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


class ClaudeCodeMissing(ProviderError):
    kind = "claude_code_missing"

    def __init__(self) -> None:
        super().__init__("Claude Code isn't installed. Install it, then sign in with `claude auth login`.")


class NotSignedIn(ProviderError):
    kind = "not_signed_in"

    def __init__(self, detail: str = "") -> None:
        super().__init__("Claude Code isn't signed in. Run `claude auth login` in a terminal, then try again.")
        self.detail = detail


def find_claude(configured: str | None = None) -> str | None:
    """Where the ``claude`` command is, or None. See cli_paths for where it looks."""
    return find_command("claude", configured, extra=[Path.home() / ".claude" / "local"])


def child_env() -> dict[str, str]:
    """This process's environment without the variables that select an API account."""
    return {k: v for k, v in os.environ.items() if k not in _API_ENV}


def _no_window() -> int:
    return subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0


def status(configured: str | None = None) -> dict:
    """Whether Claude Code is installed and signed in, for the Settings screen."""
    path = find_claude(configured)
    if path is None:
        return {"installed": False, "signed_in": False, "path": None, "version": None, "auth_method": None}
    info: dict = {"installed": True, "signed_in": False, "path": path, "version": None, "auth_method": None}
    try:
        version = subprocess.run(
            [path, "--version"], capture_output=True, text=True, timeout=20, env=child_env(), creationflags=_no_window()
        )
        info["version"] = version.stdout.strip().split(" ")[0] or None
        auth = subprocess.run(
            [path, "auth", "status", "--json"],
            capture_output=True, text=True, timeout=20, env=child_env(), creationflags=_no_window(),
        )
        data = json.loads(auth.stdout or "{}")
        info["signed_in"] = bool(data.get("loggedIn"))
        info["auth_method"] = data.get("authMethod")
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        pass
    return info


class ClaudeCodeProvider(Provider):
    kind = "claude_code"
    label = "Claude Code (Pro plan)"

    def __init__(self, model: str = DEFAULT_MODEL, effort: str | None = None, command: str | None = None) -> None:
        super().__init__(model)
        self.effort = effort
        self.command = command

    def _args(self, claude: str, request: CompletionRequest) -> list[str]:
        args = [
            claude,
            "-p",
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model", self.model,
            "--system-prompt", f"{request.system}\n\n{request.context}",
            "--json-schema", json.dumps(request.json_schema()),
            "--tools", "",
            "--no-session-persistence",
        ]
        if self.effort:
            args += ["--effort", self.effort]
        return args

    def _send(self, request: CompletionRequest, on_delta: DeltaSink) -> RawReply:
        claude = find_claude(self.command)
        if claude is None:
            raise ClaudeCodeMissing()
        # Run in an empty folder, so no project settings or files are picked up.
        # stderr goes to a file: a full pipe nobody reads could stall the child.
        with tempfile.TemporaryDirectory(prefix="tailor-claude-") as workdir, tempfile.TemporaryFile("w+") as errors:
            try:
                proc = subprocess.Popen(
                    self._args(claude, request),
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
                raise ClaudeCodeMissing() from e
            proc.stdin.write(request.user + "\n\nReply with JSON only.")
            proc.stdin.close()
            result = None
            with Watchdog(proc, TIMEOUT_SECONDS, IDLE_SECONDS) as watchdog:
                for line in proc.stdout:
                    watchdog.alive()
                    event = _parse_line(line)
                    if event is None:
                        continue
                    if event.get("type") == "stream_event":
                        _forward_delta(event.get("event", {}), on_delta)
                    elif event.get("type") == "result":
                        # The answer is in. Don't wait for the output to close: a command that
                        # lingers after answering would hold the step open.
                        result = event
                        break
            try:
                proc.wait(timeout=EXIT_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                kill_tree(proc)
                proc.wait()
            if watchdog.fired and result is None:
                raise OtherError(watchdog.message("Claude Code"))
            errors.seek(0)
            stderr = errors.read()
        return _reply_from_result(result, stderr, self.model)


def _parse_line(line: str) -> dict | None:
    line = line.strip()
    if not line:
        return None
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None  # print mode can write a plain-text warning line now and then


def _forward_delta(event: dict, on_delta: DeltaSink) -> None:
    """Pass streamed text to the live view.

    Structured output can arrive as the input of an internal tool call, so
    partial JSON is forwarded too.
    """
    if event.get("type") != "content_block_delta":
        return
    delta = event.get("delta", {})
    if delta.get("type") == "text_delta" and delta.get("text"):
        on_delta(delta["text"])
    elif delta.get("type") == "input_json_delta" and delta.get("partial_json"):
        on_delta(delta["partial_json"])


def _reply_from_result(result: dict | None, stderr: str, model: str) -> RawReply:
    if result is None:
        detail = stderr.strip().splitlines()[-1] if stderr.strip() else "no result"
        raise OtherError(f"Claude Code stopped without an answer: {detail}")
    if result.get("is_error") or result.get("subtype") != "success":
        message = str(result.get("result") or result.get("subtype") or "unknown error")
        if "login" in message.lower() or "not logged in" in message.lower() or "authenticate" in message.lower():
            raise NotSignedIn(message)
        raise OtherError(f"Claude Code failed: {message}")

    structured = result.get("structured_output")
    text = json.dumps(structured) if structured is not None else str(result.get("result") or "")
    u = result.get("usage") or {}
    usage = Usage(
        input_tokens=u.get("input_tokens", 0),
        output_tokens=u.get("output_tokens", 0),
        cache_read_tokens=u.get("cache_read_input_tokens", 0),
        cache_write_tokens=u.get("cache_creation_input_tokens", 0),
    )
    # modelUsage is keyed by the full model id, which is more useful than the alias.
    model_ids = list((result.get("modelUsage") or {}).keys())
    return RawReply(text=text, usage=usage, model=model_ids[0] if model_ids else model)
