"""Opens the Tailor window.

The interface is one self-contained HTML file (built from ui/ by Vite) loaded
from a file:// URL, so there is no local web server and no open port. The page
reaches Python only through the ``Bridge`` object handed to pywebview.

Run it in development with:  uv run python -m app.main
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import webview

from app.bridge import APP_NAME, Backend, Bridge, default_data_dir, window_emitter
from app.core.db import Db
from app.core.secrets import KeychainStore


def ui_file() -> Path:
    """The built interface: inside the app bundle when packaged, ui/dist in development."""
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        return Path(bundle) / "ui" / "index.html"
    return Path(__file__).resolve().parent.parent / "ui" / "dist" / "index.html"


def main() -> None:
    logging.basicConfig(level=logging.INFO if os.environ.get("TAILOR_DEBUG") else logging.WARNING)
    page = ui_file()
    if not page.is_file():
        sys.exit(f"The interface hasn't been built yet: {page} is missing. Run `npm run build` in ui/.")

    data_dir = default_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    backend = Backend(data_dir, Db(data_dir / "tailor.db"), KeychainStore())

    # "?desktop=1" tells the page to wait for the Python bridge instead of using its browser mock.
    window = webview.create_window(
        APP_NAME,
        url=page.as_uri() + "?desktop=1",
        js_api=Bridge(backend),
        width=1440,
        height=900,
        min_size=(1100, 700),
        background_color="#111111",
    )
    backend.window = window
    backend.emit = window_emitter(window)
    webview.start(debug=bool(os.environ.get("TAILOR_DEBUG")))


if __name__ == "__main__":
    main()
