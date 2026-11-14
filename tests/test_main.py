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
