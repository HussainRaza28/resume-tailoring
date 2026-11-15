"""Finding a command-line tool when the app wasn't started from a terminal.

An app opened from the Start menu, Finder or Dock doesn't get the shell's
``PATH``, so ``shutil.which`` alone misses tools installed in the user's own
folders. This module checks the places the installers for Claude Code and Codex
put them: ``~/.local/bin`` (and ``%USERPROFILE%\\.local\\bin`` on Windows),
npm's global folder, and Homebrew's.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

# File names a command can have on Windows, tried in this order.
_WINDOWS_SUFFIXES = (".exe", ".cmd", ".bat", "")


def _names(command: str, windows: bool) -> list[str]:
    return [command + s for s in _WINDOWS_SUFFIXES] if windows else [command]


def search_dirs(extra: list[Path] | None = None, *, windows: bool | None = None, env: dict | None = None,
                home: Path | None = None) -> list[Path]:
    """The folders to look in, beyond ``PATH``, most likely first."""
    windows = sys.platform == "win32" if windows is None else windows
    env = os.environ if env is None else env
    home = Path.home() if home is None else home
    dirs: list[Path] = list(extra or [])
    if windows:
        profile = env.get("USERPROFILE")
        if profile:
            dirs.append(Path(profile) / ".local" / "bin")
        dirs.append(home / ".local" / "bin")
        appdata = env.get("APPDATA")
        if appdata:
            dirs.append(Path(appdata) / "npm")
        prefix = env.get("NPM_CONFIG_PREFIX") or env.get("npm_config_prefix")
        if prefix:
            dirs.append(Path(prefix))
        local = env.get("LOCALAPPDATA")
        if local:
            dirs.append(Path(local) / "Programs")
    else:
        dirs.append(home / ".local" / "bin")
        prefix = env.get("NPM_CONFIG_PREFIX") or env.get("npm_config_prefix")
        if prefix:
            dirs.append(Path(prefix) / "bin")
        dirs += [
            home / ".npm-global" / "bin",
            home / ".volta" / "bin",
            home / ".bun" / "bin",
            Path("/opt/homebrew/bin"),
            Path("/usr/local/bin"),
            Path("/home/linuxbrew/.linuxbrew/bin"),
            Path("/usr/bin"),
        ]
        # nvm keeps one folder per Node version; newest first.
        nvm = home / ".nvm" / "versions" / "node"
        if nvm.is_dir():
            dirs += [v / "bin" for v in sorted(nvm.iterdir(), reverse=True)]
    seen: set[str] = set()
    unique = []
    for d in dirs:
        if str(d) not in seen:
            seen.add(str(d))
            unique.append(d)
    return unique


def find_command(command: str, configured: str | None = None, extra: list[Path] | None = None) -> str | None:
    """Where ``command`` is, or None. A path chosen in Settings wins when it exists."""
    if configured and Path(configured).is_file():
        return configured
    on_path = shutil.which(command)
    if on_path:
        return on_path
    windows = sys.platform == "win32"
    for folder in search_dirs(extra, windows=windows):
        for name in _names(command, windows):
            candidate = folder / name
            if candidate.is_file():
                return str(candidate)
    return None
