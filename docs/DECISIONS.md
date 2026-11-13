# Decisions

Choices made while building Tailor, with the reason for each.

## Project setup

- **uv and Python 3.12.** `.python-version` pins 3.12, the oldest version the app supports, so the tests run on the oldest version a user might have. `pyproject.toml` sets `package = false` because Tailor is an app, and nothing installs it as a library.
- **Dependencies so far.** `pydantic` describes edits and slots, which cross to the interface as JSON and need checking when they come back. `pypdf` counts the pages in a compiled PDF. `pytest` is a dev dependency.
- **Private data stays out of git.** `data/private/` is ignored. It holds the real resume, pasted postings, tailored outputs, the facts bank and the database. Tests use only the fake resume and posting in `tests/fixtures/`.

## Template engine

- **Slot positions are character indexes** into the source string, because that is how Python slices strings. A test reads the sample as bytes, applies no edits and compares the bytes, so the round trip is exact at the byte level too.
- **A slot kind is a name plus an argument number**, such as `kind="subheading"` and `arg=2`. Both are plain values, so a slot turns into JSON for the interface without a custom encoder.

## Compiling to PDF

- **Tectonic 0.15.0, pinned.** It is the newest release with ready-made builds for Apple Silicon Macs, Windows and Linux. A pinned version means every build ships the same Tectonic, and the download script needs no GitHub API call to pick one.
- **The download script unpacks archives in Python.** `scripts/fetch_tectonic.py` uses `tarfile` and `zipfile`, so the same code runs on every OS. Shelling out to `tar` would depend on which `tar` comes first in `PATH`, and on Windows Git Bash's `tar` reads `C:` as a remote host name.
- **Where the app looks for Tectonic**, in order: the path set in Settings, `TAILOR_TECTONIC`, the bundled copy (`packaging/bin/` in development, the PyInstaller folder in a build), `PATH`, then the Homebrew and Cargo folders, which a Mac app launched from Finder doesn't have in its `PATH`.
- **XeTeX wrapper.** Tectonic runs XeTeX, and the template's `\input{glyphtounicode}` and `\pdfgentounicode=1` only exist in pdfTeX, so compiling the file directly fails with "Undefined control sequence". Each compile writes `tailor_main.tex`, which defines do-nothing versions of both commands when they are missing and then `\input`s the resume. The user's file is never edited. XeTeX writes Unicode text into the PDF by itself, so ATS parsers can still read it. A test compiles the sample without the wrapper and checks that it fails.
- **One Tectonic run at a time.** On Windows, two runs that build Tectonic's format file at the same moment fail with "Access is denied". `compile_tex` holds a `threading.Lock` while Tectonic runs. A test starts four compiles at once against a fake Tectonic that records overlaps, and it fails if the lock is removed.
- **Five-minute compile timeout.** The first compile downloads TeX packages, which took about 30 seconds on a fast connection. The limit leaves room for a slow one.

## Tests and CI

- **Tests that need Tectonic** are skipped when it isn't installed, so a fresh checkout can run everything else. CI sets `TAILOR_REQUIRE_TECTONIC=1`, which turns a missing Tectonic into a failure.
- **CI runs the tests on Linux, macOS and Windows**, because the compile lock and the Tectonic download both behave differently on Windows.
