"""Finding claude and codex when the app wasn't started from a terminal."""

from pathlib import Path

from app.providers import cli_paths
from app.providers.cli_paths import find_command, search_dirs


def _tool(folder: Path, name: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_text("#!/bin/sh\n")
    path.chmod(0o755)
    return path


def test_a_chosen_path_wins(tmp_path, monkeypatch):
    chosen = _tool(tmp_path / "mine", "claude")
    monkeypatch.setattr(cli_paths.shutil, "which", lambda _c: "/elsewhere/claude")
    assert find_command("claude", str(chosen)) == str(chosen)


def test_a_chosen_path_that_is_gone_falls_back(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_paths.shutil, "which", lambda _c: "/on/path/claude")
    assert find_command("claude", str(tmp_path / "missing")) == "/on/path/claude"


def test_found_in_the_users_local_bin_without_path(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_paths.shutil, "which", lambda _c: None)
    monkeypatch.setattr(cli_paths.sys, "platform", "darwin")
    monkeypatch.setattr(cli_paths.Path, "home", lambda: tmp_path)
    tool = _tool(tmp_path / ".local" / "bin", "codex")
    assert find_command("codex") == str(tool)


def test_extra_folders_are_checked(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_paths.shutil, "which", lambda _c: None)
    monkeypatch.setattr(cli_paths.sys, "platform", "linux")
    monkeypatch.setattr(cli_paths.Path, "home", lambda: tmp_path / "home")
    tool = _tool(tmp_path / "special", "claude")
    assert find_command("claude", extra=[tmp_path / "special"]) == str(tool)


def test_nothing_found(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_paths.shutil, "which", lambda _c: None)
    monkeypatch.setattr(cli_paths.Path, "home", lambda: tmp_path)
    monkeypatch.setattr(cli_paths, "search_dirs", lambda extra=None, **_k: [tmp_path / "empty"])
    assert find_command("claude") is None


def test_windows_folders(tmp_path):
    env = {"USERPROFILE": r"C:\Users\h", "APPDATA": r"C:\Users\h\AppData\Roaming"}
    dirs = [str(d) for d in search_dirs(windows=True, env=env, home=tmp_path)]
    assert str(Path(r"C:\Users\h") / ".local" / "bin") in dirs
    assert str(Path(r"C:\Users\h\AppData\Roaming") / "npm") in dirs


def test_mac_folders_include_homebrew_and_npm(tmp_path):
    dirs = [str(d) for d in search_dirs(windows=False, env={"NPM_CONFIG_PREFIX": "/opt/npm"}, home=tmp_path)]
    assert str(Path("/opt/homebrew/bin")) in dirs
    assert str(Path("/usr/local/bin")) in dirs
    assert str(Path("/opt/npm") / "bin") in dirs
    assert str(tmp_path / ".npm-global" / "bin") in dirs
    assert dirs[0] == str(tmp_path / ".local" / "bin")


def test_windows_finds_a_cmd_shim(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_paths.shutil, "which", lambda _c: None)
    monkeypatch.setattr(cli_paths.sys, "platform", "win32")
    monkeypatch.setattr(cli_paths, "search_dirs", lambda extra=None, **_k: [tmp_path / "npm"])
    shim = _tool(tmp_path / "npm", "codex.cmd")
    assert find_command("codex") == str(shim)
