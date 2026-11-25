"""Time limits for a command-line provider (Claude Code, Codex) while its output is read.

The app reads the command's output line by line until it closes. A limit
checked only after that read never fires if the command stops printing but
keeps its output open, and then the step hangs. This watches from another
thread and stops the command when either limit passes:

- the whole call takes longer than ``total`` seconds, or
- nothing is printed for ``idle`` seconds.

Stopping the command closes its output, so the read ends and the provider
can report which limit was hit.
"""

from __future__ import annotations

import subprocess
import sys
import threading
import time


def kill_tree(proc: subprocess.Popen) -> None:
    """Stop a command and anything it started.

    On Windows a command installed by npm is a .cmd file, so the process the
    app started is cmd.exe and the real program is its child. Stopping only
    cmd.exe would leave the child running with the output still open.
    """
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
            capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    try:
        proc.kill()
    except OSError:
        pass


class Watchdog:
    def __init__(self, proc: subprocess.Popen, total: float, idle: float, poll: float = 0.25) -> None:
        self.proc = proc
        self.total = total
        self.idle = idle
        self.poll = poll
        # "total" or "idle" once the command was stopped for running too long.
        self.fired: str | None = None
        self._started = time.monotonic()
        self._last = self._started
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._watch, name="provider-watchdog", daemon=True)

    def __enter__(self) -> Watchdog:
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._done.set()

    def alive(self) -> None:
        """Call on every line of output, so a command that is still printing isn't stopped as idle."""
        self._last = time.monotonic()

    def _watch(self) -> None:
        while not self._done.wait(self.poll):
            if self.proc.poll() is not None:
                return
            now = time.monotonic()
            if now - self._started > self.total:
                self.fired = "total"
            elif now - self._last > self.idle:
                self.fired = "idle"
            else:
                continue
            kill_tree(self.proc)
            return

    def message(self, name: str) -> str:
        if self.fired == "idle":
            return f"{name} stopped answering: nothing came back for {int(self.idle)} seconds, so it was stopped."
        return f"{name} took longer than {int(self.total)} seconds, so it was stopped."
