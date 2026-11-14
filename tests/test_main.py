"""The app window: how it is opened."""

from __future__ import annotations

from pathlib import Path

import pytest

from app import main
from app.bridge import Backend
from app.core.db import Db
from app.core.secrets import MemoryStore


def test_window_url_is_a_plain_file_url(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # On Windows a "?" or "#" in a file:// URL becomes part of the file name, and
    # WebView2 shows "File not found" instead of the interface.
    opened: dict = {}

    def fake_create_window(title: str, **kwargs: object) -> object:
        opened["title"] = title
        opened.update(kwargs)
        return type("Window", (), {"run_js": lambda self, js: None})()

    monkeypatch.setattr(main.webview, "create_window", fake_create_window)
    backend = Backend(tmp_path, Db(tmp_path / "tailor.db"), MemoryStore())
    main.open_window(backend)

    url = opened["url"]
    assert url == main.ui_file().as_uri()
    assert url.startswith("file://")
    assert "?" not in url and "#" not in url
    assert opened["title"] == "Tailor"


class FakeWindow:
    """Stands in for a pywebview window. ``hang`` makes evaluate_js never return."""

    def __init__(self, page: dict, hang: bool = False) -> None:
        import threading

        self.events = type("Events", (), {"loaded": threading.Event()})()
        self.events.loaded.set()
        self.page = page
        self.hang = hang
        self.destroyed = False

    def evaluate_js(self, script: str, callback=None) -> object:
        import json
        import threading

        if self.hang:
            threading.Event().wait()
        if callback:
            callback({"ok": {"name": "Tailor"}})
            return None
        return json.dumps(self.page)

    def destroy(self) -> None:
        self.destroyed = True


def run_check(monkeypatch: pytest.MonkeyPatch, window: FakeWindow, timeout: float) -> dict:
    monkeypatch.setattr(main, "open_window", lambda backend: window)
    monkeypatch.setattr(main.webview, "start", lambda func: func())
    result: dict = {}
    main.check_window(result, save=lambda: None, timeout=timeout)
    return result


def test_window_check_passes_when_the_interface_reaches_python(monkeypatch: pytest.MonkeyPatch) -> None:
    window = FakeWindow({"title": "Tailor", "backend": "python", "rendered": True})
    result = run_check(monkeypatch, window, timeout=5)
    assert result["loaded"] is True
    assert result["stage"] == "window closed"
    assert window.destroyed


def test_window_check_fails_on_an_error_page(monkeypatch: pytest.MonkeyPatch) -> None:
    # What Windows showed: WebView2's error page, with the mangled file URL as its title.
    window = FakeWindow({"title": "file:///C:/Tailor/ui/index.html%3Fdesktop=1", "backend": None, "rendered": False})
    result = run_check(monkeypatch, window, timeout=1)
    assert result["loaded"] is False
    assert "the interface did not start" in result["log"][-3]
    assert window.destroyed


def test_window_check_finishes_when_the_page_never_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    window = FakeWindow({}, hang=True)
    result = run_check(monkeypatch, window, timeout=1)
    assert result["loaded"] is False
    assert "no answer from the page" in result["page"]["error"]
    assert window.destroyed
