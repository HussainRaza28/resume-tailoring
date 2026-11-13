"""Compile a resume to PDF with Tectonic and count its pages.

The template uses two commands that only exist in pdfTeX: ``\\pdfgentounicode``
and ``\\pdfglyphtounicode`` (through ``glyphtounicode.tex``). Tectonic runs
XeTeX, which doesn't have them, so compiling the file directly fails with
"Undefined control sequence".

We never edit the user's file to fix that. Each compile writes a small wrapper,
``tailor_main.tex``, that defines do-nothing versions of the two commands when
they are missing and then ``\\input``s the resume as it is. XeTeX already puts
Unicode text in the PDF, so ATS parsers can still read it.

Only one Tectonic run happens at a time (see ``_COMPILE_LOCK``).
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from pypdf import PdfReader

RESUME_FILE = "resume.tex"
WRAPPER_FILE = "tailor_main.tex"

WRAPPER = r"""% Generated wrapper. Defines pdfTeX-only primitives as no-ops for XeTeX.
\expandafter\ifx\csname pdfgentounicode\endcsname\relax
  \newcount\pdfgentounicode
\fi
\expandafter\ifx\csname pdfglyphtounicode\endcsname\relax
  \def\pdfglyphtounicode#1#2{}
\fi
\input{resume.tex}
"""

# The first compile downloads TeX packages, which can take a while on a slow link.
TIMEOUT_SECONDS = 300

# Two Tectonic runs that both build the format file at the same time fail on
# Windows with "Access is denied". Every compile in this process takes this
# lock, so runs happen one after another.
_COMPILE_LOCK = threading.Lock()


class CompileError(Exception):
    """Base class for compile errors. ``code`` is a short name for the UI."""

    code = "compile_error"


class TectonicMissing(CompileError):
    code = "tectonic_missing"

    def __init__(self) -> None:
        super().__init__("Tectonic was not found. Reinstall the app, or set TAILOR_TECTONIC to its path.")


class CompileFailed(CompileError):
    code = "tectonic_failed"

    def __init__(self, summary: str, log: str) -> None:
        self.summary = summary
        self.log = log
        super().__init__(f"LaTeX compile failed: {summary}")


class BadPdf(CompileError):
    code = "bad_pdf"

    def __init__(self, detail: str) -> None:
        super().__init__(f"Could not read the compiled PDF: {detail}")


@dataclass
class CompileOutput:
    pdf: bytes
    pages: int
    duration_ms: int

    @property
    def is_one_page(self) -> bool:
        return self.pages == 1


def binary_name() -> str:
    return "tectonic.exe" if sys.platform == "win32" else "tectonic"


def bundled_dir() -> Path:
    """Where the app keeps its own copy of Tectonic.

    In a PyInstaller build that is the unpacked bundle folder. In development it
    is ``packaging/bin``, where ``scripts/fetch_tectonic.py`` puts it.
    """
    frozen = getattr(sys, "_MEIPASS", None)
    if frozen:
        return Path(frozen)
    return Path(__file__).resolve().parents[2] / "packaging" / "bin"


def find_tectonic(configured: Path | None = None) -> Path | None:
    """Look for Tectonic and return the first one that exists.

    The order is: the path chosen in Settings, ``TAILOR_TECTONIC``, the copy
    bundled with the app, ``PATH``, and then the usual Homebrew and Cargo
    folders, which a Mac app launched from Finder doesn't get in its ``PATH``.
    """
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured))
    if os.environ.get("TAILOR_TECTONIC"):
        candidates.append(Path(os.environ["TAILOR_TECTONIC"]))
    candidates.append(bundled_dir() / binary_name())
    on_path = shutil.which("tectonic")
    if on_path:
        candidates.append(Path(on_path))
    candidates.append(Path("/opt/homebrew/bin") / binary_name())
    candidates.append(Path("/usr/local/bin") / binary_name())
    candidates.append(Path.home() / ".cargo" / "bin" / binary_name())
    return next((p for p in candidates if p.is_file()), None)


def count_pages(pdf: bytes) -> int:
    try:
        return len(PdfReader(io.BytesIO(pdf)).pages)
    except Exception as e:  # pypdf raises several error types for broken files
        raise BadPdf(str(e)) from e


def summarize_log(log: str) -> str:
    """Pull the useful part out of a TeX log.

    Keeps lines that start with ``!`` or ``error:``, plus the ``l.<number>``
    line after them, which says where the error is. Falls back to the last
    four lines when there are none.
    """
    lines = log.splitlines()
    found: list[str] = []
    for i, line in enumerate(lines):
        if line.startswith("!") or line.startswith("error:"):
            found.append(line.strip())
            if i + 1 < len(lines) and lines[i + 1].startswith("l."):
                found.append(lines[i + 1].strip())
        if len(found) >= 6:
            break
    if not found:
        found = [line.strip() for line in lines[-4:]]
    return " | ".join(found)


def compile_tex(tex: str, tectonic: Path | None = None) -> CompileOutput:
    """Compile resume source to a PDF in a fresh temporary folder.

    ``tex`` is written to ``resume.tex`` unchanged, next to the wrapper.
    """
    tectonic = tectonic or find_tectonic()
    if tectonic is None:
        raise TectonicMissing()

    with tempfile.TemporaryDirectory(prefix="tailor-") as tmp:
        folder = Path(tmp)
        # newline="" so the text is written exactly as given, with no line-ending changes.
        (folder / RESUME_FILE).write_text(tex, encoding="utf-8", newline="")
        (folder / WRAPPER_FILE).write_text(WRAPPER, encoding="utf-8", newline="")

        # On Windows, stop a console window from flashing up.
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        with _COMPILE_LOCK:
            start = time.monotonic()
            try:
                result = subprocess.run(
                    [str(tectonic), "-X", "compile", "--keep-logs", WRAPPER_FILE],
                    cwd=folder,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=TIMEOUT_SECONDS,
                    creationflags=flags,
                )
            except FileNotFoundError as e:
                raise TectonicMissing() from e
            except subprocess.TimeoutExpired as e:
                raise CompileFailed(f"Tectonic took longer than {TIMEOUT_SECONDS} seconds", "") from e
            duration_ms = int((time.monotonic() - start) * 1000)

        log = result.stderr
        tex_log = folder / "tailor_main.log"
        if tex_log.exists():
            log += "\n" + tex_log.read_text(encoding="utf-8", errors="replace")
        pdf_path = folder / "tailor_main.pdf"
        if result.returncode != 0 or not pdf_path.exists():
            raise CompileFailed(summarize_log(log), log)
        pdf = pdf_path.read_bytes()

    return CompileOutput(pdf=pdf, pages=count_pages(pdf), duration_ms=duration_ms)
