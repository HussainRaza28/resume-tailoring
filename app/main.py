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

from app.bridge import APP_NAME, Backend, Bridge, default_data_dir, location_file, window_emitter
from app.core.db import Db
from app.core.secrets import KeychainStore


def ui_file() -> Path:
    """The built interface: inside the app bundle when packaged, ui/dist in development."""
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        return Path(bundle) / "ui" / "index.html"
    return Path(__file__).resolve().parent.parent / "ui" / "dist" / "index.html"


# A small document that uses the template's pdfTeX-only lines, so the self-test
# also proves the XeTeX wrapper works inside the packaged app.
SELF_TEST_TEX = r"""\documentclass{article}
\input{glyphtounicode}
\pdfgentounicode=1
\begin{document}
Tailor self-test
\end{document}
"""


def self_test(report: Path) -> int:
    """Check a packaged build without opening a window, and write the results as JSON.

    CI runs this on every installer it builds. The results go to a file because a
    windowed app on Windows has no console to print to.
    """
    import json

    import keyring

    from app.core.compile import compile_tex, find_tectonic
    from app.core.skills import lexicon

    results: dict = {"ui": ui_file().is_file(), "lexicon_entries": len(lexicon().entries)}
    results["keyring_backend"] = type(keyring.get_keyring()).__name__
    if sys.platform == "darwin":
        import webview.platforms.cocoa  # noqa: F401  (the Mac webview must load in the bundle)
    elif sys.platform == "win32":
        import webview.platforms.edgechromium  # noqa: F401
    results["webview"] = True
    tectonic = find_tectonic()
    results["tectonic"] = str(tectonic) if tectonic else None
    results["pages"] = compile_tex(SELF_TEST_TEX, tectonic).pages if tectonic else None
    ok = results["ui"] and results["lexicon_entries"] > 250 and results["pages"] == 1
    results["ok"] = bool(ok)
    report.write_text(json.dumps(results, indent=2), encoding="utf-8")
    return 0 if ok else 1


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--self-test":
        sys.exit(self_test(Path(sys.argv[2])))
    logging.basicConfig(level=logging.INFO if os.environ.get("TAILOR_DEBUG") else logging.WARNING)
    page = ui_file()
    if not page.is_file():
        sys.exit(f"The interface hasn't been built yet: {page} is missing. Run `npm run build` in ui/.")

    data_dir = default_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    backend = Backend(data_dir, Db(data_dir / "tailor.db"), KeychainStore(), location=location_file())

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
