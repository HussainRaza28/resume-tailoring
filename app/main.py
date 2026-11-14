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
from collections.abc import Callable
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


def open_window(backend: Backend) -> webview.Window:
    """Create the app window. The app and the self-test both open it this way."""
    # A plain file:// URL with no query string. On Windows, pywebview hands the URL
    # to .NET's Uri class, which reads "?..." in a file URL as part of the file name.
    # The page knows it is in the app because it was opened from a file:// address.
    window = webview.create_window(
        APP_NAME,
        url=ui_file().as_uri(),
        js_api=Bridge(backend),
        width=1440,
        height=900,
        min_size=(1100, 700),
        background_color="#111111",
    )
    backend.window = window
    backend.emit = window_emitter(window)
    return window


# Read from the page by the window check. data-backend is set by main.tsx once it
# knows whether it is talking to Python or to the browser mock.
PAGE_STATE_JS = """JSON.stringify({
  title: document.title,
  href: location.href,
  backend: document.documentElement.dataset.backend || null,
  rendered: !!document.querySelector("#root > *")
})"""


def check_window(result: dict, save: Callable[[], None], timeout: float = 60.0) -> None:
    """Open the real window, check that the interface loaded and can reach Python, then close it.

    Fills in ``result`` as it goes and calls ``save`` after each stage, so the
    report shows how far it got even if a webview call never returns. A watchdog
    ends the process if the whole check takes too long.

    Uses a throwaway data folder and an in-memory key store, so it never touches
    the user's data or keychain.
    """
    import json
    import tempfile
    import threading
    import time

    from app.core.secrets import MemoryStore

    started = time.monotonic()
    result.update(loaded=False, stage="", log=[], page=None, bridge_reply=None)

    def stage(name: str) -> None:
        result["stage"] = name
        result["log"].append(f"{time.monotonic() - started:5.1f}s {name}")
        save()

    def give_up() -> None:
        stage("gave up: the window check did not finish in time")
        os._exit(1)

    watchdog = threading.Timer(timeout * 2 + 30, give_up)
    watchdog.daemon = True
    watchdog.start()

    data_dir = Path(tempfile.mkdtemp(prefix="tailor-selftest-"))
    backend = Backend(data_dir, Db(data_dir / "tailor.db"), MemoryStore())
    window = open_window(backend)

    def run_js(script: str, wait: float = min(15.0, timeout)) -> object:
        """evaluate_js with a time limit. On macOS it waits forever if the page never answers."""
        answer: dict = {}

        def call() -> None:
            try:
                answer["value"] = window.evaluate_js(script)
            except Exception as e:  # noqa: BLE001  (reported, then retried by the caller)
                answer["error"] = str(e)

        worker = threading.Thread(target=call, daemon=True)
        worker.start()
        worker.join(wait)
        if worker.is_alive():
            raise TimeoutError(f"no answer from the page after {wait:.0f}s")
        if "error" in answer:
            raise RuntimeError(answer["error"])
        return answer.get("value")

    def probe() -> None:
        try:
            stage("waiting for the page to load")
            if not window.events.loaded.wait(timeout):
                stage("the page never finished loading")
                return
            stage("reading the page")
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    page = json.loads(str(run_js(PAGE_STATE_JS)))
                except Exception as e:  # noqa: BLE001  (the page may still be starting)
                    page = {"error": str(e)}
                if page != result["page"]:
                    result["page"] = page
                    stage("reading the page")
                if page.get("backend") == "python" and page.get("rendered"):
                    break
                time.sleep(0.5)
            else:
                stage("the interface did not start")
                return

            # One round trip through the bridge, the same way the interface calls Python.
            stage("calling Python through the bridge")
            answered = threading.Event()

            def got(reply: object) -> None:
                result["bridge_reply"] = reply
                answered.set()

            window.evaluate_js('window.pywebview.api.call("app_info", {})', got)
            if not answered.wait(30):
                stage("the bridge call got no answer")
                return
            reply = result["bridge_reply"]
            result["loaded"] = isinstance(reply, dict) and reply.get("ok", {}).get("name") == APP_NAME
            stage("bridge answered" if result["loaded"] else "the bridge answered with something unexpected")
        finally:
            stage("closing the window")
            window.destroy()

    webview.start(probe)
    watchdog.cancel()
    stage("window closed")


def self_test(report: Path) -> int:
    """Check a packaged build, including opening its window, and write the results as JSON.

    CI runs this on every installer it builds. The results go to a file because a
    windowed app on Windows has no console to print to.
    """
    import json

    import keyring

    from app.core.compile import compile_tex, find_tectonic
    from app.core.skills import lexicon

    results: dict = {"ui": ui_file().is_file(), "lexicon_entries": len(lexicon().entries)}

    def save() -> None:
        report.write_text(json.dumps(results, indent=2), encoding="utf-8")

    results["keyring_backend"] = type(keyring.get_keyring()).__name__
    if sys.platform == "darwin":
        import webview.platforms.cocoa  # noqa: F401  (the Mac webview must load in the bundle)
    elif sys.platform == "win32":
        import webview.platforms.edgechromium  # noqa: F401
    results["webview"] = True
    tectonic = find_tectonic()
    results["tectonic"] = str(tectonic) if tectonic else None
    results["pages"] = compile_tex(SELF_TEST_TEX, tectonic).pages if tectonic else None
    results["window"] = {}
    save()
    check_window(results["window"], save)
    ok = results["ui"] and results["lexicon_entries"] > 250 and results["pages"] == 1 and results["window"]["loaded"]
    results["ok"] = bool(ok)
    save()
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

    open_window(backend)
    webview.start(debug=bool(os.environ.get("TAILOR_DEBUG")))


if __name__ == "__main__":
    main()
