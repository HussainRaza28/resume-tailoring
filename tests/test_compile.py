"""Tests for compiling to PDF.

Covers the one-page check (a longer result is flagged), the XeTeX wrapper,
and the lock that stops two Tectonic runs overlapping.

Tests marked ``tectonic`` need the real binary. They are skipped when it can't
be found, unless ``TAILOR_REQUIRE_TECTONIC=1`` is set, as it is in CI.
"""

import io
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest
from pypdf import PdfWriter

from app.core.compile import (
    WRAPPER,
    CompileFailed,
    TectonicMissing,
    compile_tex,
    count_pages,
    find_tectonic,
    summarize_log,
)
from app.core.tex import SetText, TexDoc

SAMPLE = (Path(__file__).parent / "fixtures" / "sample_resume.tex").read_text(encoding="utf-8")

# A stand-in for Tectonic. It records what it was given, notices if another
# run is going at the same time, and writes the PDF named in FAKE_PDF.
FAKE_TECTONIC = r'''
import os, shutil, sys, time
shared = os.environ["FAKE_SHARED"]
try:
    fd = os.open(os.path.join(shared, "running"), os.O_CREAT | os.O_EXCL)
    os.close(fd)
except FileExistsError:
    open(os.path.join(shared, "overlap"), "w").close()
time.sleep(0.2)
run = os.path.join(shared, "run-%d" % os.getpid())
os.mkdir(run)
shutil.copy("resume.tex", run)
shutil.copy("tailor_main.tex", run)
with open(os.path.join(run, "args.txt"), "w") as f:
    f.write(" ".join(sys.argv[1:]))
if os.environ.get("FAKE_FAIL"):
    os.remove(os.path.join(shared, "running"))
    sys.stderr.write("! Undefined control sequence.\nl.7 \\pdfglyphtounicode\n")
    sys.exit(1)
shutil.copy(os.environ["FAKE_PDF"], "tailor_main.pdf")
os.remove(os.path.join(shared, "running"))
'''


def blank_pdf(path: Path, pages: int) -> None:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    with open(path, "wb") as f:
        writer.write(f)


@pytest.fixture
def fake_tectonic(tmp_path, monkeypatch) -> Path:
    script = tmp_path / "fake_tectonic.py"
    script.write_text(FAKE_TECTONIC)
    shared = tmp_path / "shared"
    shared.mkdir()
    pdf = tmp_path / "one.pdf"
    blank_pdf(pdf, 1)
    monkeypatch.setenv("FAKE_SHARED", str(shared))
    monkeypatch.setenv("FAKE_PDF", str(pdf))
    if sys.platform == "win32":
        launcher = tmp_path / "tectonic.cmd"
        launcher.write_text(f'@"{sys.executable}" "{script}" %*\n')
    else:
        launcher = tmp_path / "tectonic"
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
        launcher.chmod(0o755)
    return launcher


@pytest.fixture
def tectonic() -> Path:
    found = find_tectonic()
    if found is None:
        if os.environ.get("TAILOR_REQUIRE_TECTONIC") == "1":
            pytest.fail("TAILOR_REQUIRE_TECTONIC=1 but Tectonic was not found")
        pytest.skip("Tectonic not found")
    return found


# -- without Tectonic ---------------------------------------------------------


def test_wrapper_inputs_resume_file():
    assert r"\input{resume.tex}" in WRAPPER
    assert r"\newcount\pdfgentounicode" in WRAPPER
    assert r"\def\pdfglyphtounicode#1#2{}" in WRAPPER


def test_log_summary_keeps_error_lines():
    log = "This is XeTeX\n! Undefined control sequence.\nl.7 \\pdfglyphtounicode\nmore\n"
    assert summarize_log(log) == "! Undefined control sequence. | l.7 \\pdfglyphtounicode"
    assert summarize_log("a\nb\nc") == "a | b | c"


def test_count_pages():
    for pages in (1, 2):
        writer = PdfWriter()
        for _ in range(pages):
            writer.add_blank_page(width=612, height=792)
        buf = io.BytesIO()
        writer.write(buf)
        assert count_pages(buf.getvalue()) == pages


def test_missing_tectonic(tmp_path):
    with pytest.raises(TectonicMissing):
        compile_tex(SAMPLE, tmp_path / "no-such-tectonic")


def test_resume_is_passed_unchanged_next_to_the_wrapper(fake_tectonic):
    out = compile_tex(SAMPLE, fake_tectonic)
    assert out.pages == 1 and out.is_one_page
    [run] = Path(os.environ["FAKE_SHARED"]).glob("run-*")
    assert (run / "resume.tex").read_bytes() == SAMPLE.encode("utf-8")
    assert (run / "tailor_main.tex").read_text(encoding="utf-8") == WRAPPER
    assert (run / "args.txt").read_text() == "-X compile --keep-logs tailor_main.tex"


def test_failed_compile_reports_the_error(fake_tectonic, monkeypatch):
    monkeypatch.setenv("FAKE_FAIL", "1")
    with pytest.raises(CompileFailed) as err:
        compile_tex(SAMPLE, fake_tectonic)
    assert err.value.summary == "! Undefined control sequence. | l.7 \\pdfglyphtounicode"


def test_compiles_never_overlap(fake_tectonic):
    errors = []

    def run():
        try:
            compile_tex(SAMPLE, fake_tectonic)
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=run) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    shared = Path(os.environ["FAKE_SHARED"])
    assert errors == []
    assert len(list(shared.glob("run-*"))) == 4
    assert not (shared / "overlap").exists()


# -- with the real Tectonic ---------------------------------------------------


@pytest.mark.tectonic
def test_sample_compiles_to_one_page(tectonic):
    out = compile_tex(SAMPLE, tectonic)
    assert out.pages == 1
    assert out.is_one_page
    assert out.pdf.startswith(b"%PDF")


@pytest.mark.tectonic
def test_sample_fails_without_the_wrapper(tectonic, tmp_path):
    # The reason the wrapper exists: the template on its own breaks under XeTeX.
    (tmp_path / "resume.tex").write_text(SAMPLE, encoding="utf-8")
    result = subprocess.run(
        [str(tectonic), "-X", "compile", "resume.tex"], cwd=tmp_path, capture_output=True, text=True
    )
    assert result.returncode != 0
    assert "Undefined control sequence" in result.stdout + result.stderr


@pytest.mark.tectonic
def test_longer_than_one_page_is_flagged(tectonic):
    doc = TexDoc.parse(SAMPLE)
    long_text = "Wrote and reviewed code for the routing service every week. " * 20
    edits = [SetText(slot=s.id, text=long_text) for s in doc.bullets_in(["experience", "projects"])]
    out = compile_tex(doc.apply(edits), tectonic)
    assert out.pages > 1
    assert not out.is_one_page


@pytest.mark.tectonic
def test_latex_error_is_summarized(tectonic):
    broken = SAMPLE.replace("\\begin{document}", "\\begin{document}\n\\notACommand", 1)
    with pytest.raises(CompileFailed) as err:
        compile_tex(broken, tectonic)
    assert "Undefined control sequence" in err.value.summary
