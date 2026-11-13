# Decisions

Choices made while building Tailor, with the reason for each.

## Project setup

- **uv and Python 3.12.** `.python-version` pins 3.12, the oldest version the app supports, so the tests run on the oldest version a user might have. `pyproject.toml` sets `package = false` because Tailor is an app, and nothing installs it as a library.
- **Dependencies so far.** `pydantic` describes edits and slots, which cross to the interface as JSON and need checking when they come back. `pypdf` counts the pages in a compiled PDF. `pytest` is a dev dependency.
- **Private data stays out of git.** `data/private/` is ignored. It holds the real resume, pasted postings, tailored outputs, the facts bank and the database. Tests use only the fake resume and posting in `tests/fixtures/`.

## Template engine

- **Slot positions are character indexes** into the source string, because that is how Python slices strings. A test reads the sample as bytes, applies no edits and compares the bytes, so the round trip is exact at the byte level too.
- **A slot kind is a name plus an argument number**, such as `kind="subheading"` and `arg=2`. Both are plain values, so a slot turns into JSON for the interface without a custom encoder.
- **Plain text in, escaped LaTeX out.** Models and the interface see slot text as plain text. `plain_to_tex` escapes every special character, so model output can't add commands. Text that didn't change keeps its original bytes, so accepting nothing reproduces the input file exactly.
- **A small markup mapping.** `\textbf{x}` shows as `**x**`, `\emph{x}` and `\textit{x}` as `*x*`, `$\sim$` as `~`, `$|$` as `|`, ``` ``x'' ``` as curly quotes and `--` as an en dash. A slot that uses any other command is shown as raw LaTeX, and only the user can edit it.
- **Hand-typed LaTeX is allowlisted.** A hand edit may only use `\textbf \emph \textit \underline \href \sim \textbackslash \textless \textgreater`. Checking brace balance and the skeleton isn't enough on its own, because `\section{...}` inside a bullet's braces keeps both intact. The allowlist also blocks font-size and spacing commands, so an edit can't shrink the page to fit.
- **Removing a bullet is the one structural edit**, because trimming to one page needs it. It removes the whole `\resumeItem{...}` line, and the skeleton check expects that line to be gone.
- **Section order is locked**, so no edit can add a Summary or Objective section.

## Truth checks

- **Grounding sources.** A rewrite is checked against the bullets and facts it cites, plus its own original bullet and the heading of the role or project it sits under (company, title, project name and stack). The heading is there so a bullet can name its own employer or stack. Anything else has to be cited.
- **What counts as a claim.** Numbers, including spelled-out ones, `k` and `M`, percentages and ratios like `2x` or `twice`. Capitalized words that aren't ordinary sentence starts. Mixed-case words like `iPhone` or `DynamoDB`. Any skill in the lexicon. Lowercase tool names that aren't in the lexicon slip through; adding them to `skills.txt` closes the gap one name at a time.
- **No derived numbers.** A percentage needs a percentage in the source, and a ratio needs a ratio. "75% fewer calls" from "12,000 to 3,000" is correct math, but a hiring manager can't check a number the resume never stated, and a model that does arithmetic can also do it wrong.
- **Style rules only blame what the rewrite added.** Lists of three, contrasts and AI mentions are compared with the source bullets, and a pattern that was already there isn't flagged. Em dashes, stock words, self-comparisons and numbers with no unit are flagged wherever they appear.
- **The lexicon lives in a text file** (`app/core/skills.txt`) so adding a skill or alias needs no code change. A leading `=` makes a name case-sensitive, which keeps "go fast" from counting as Go. One-letter names like C and R also need list context, so "Series C startup" doesn't count as knowing C.
- **Coverage only counts real skills.** A skill counts as covered only when the scored resume shows it and the base resume or facts bank backs it up. Required coverage is covered divided by the required skills you have. Required skills you don't have aren't in the denominator, because no honest rewrite can add them.
- **Posting tiers.** Skills under a requirements heading are required, under a preferred or nice-to-have heading preferred, and a line saying "a plus" or "preferred" is preferred wherever it sits. If the posting has no requirements heading, every skill found is required. A skill keeps its strongest tier.
- **The facts bank is a JSON file** in the private data folder. It's small, the user may want to read or back it up by hand, and it's written to a temporary file and then swapped in, so a crash can't leave half a file. Fact ids are never reused after a delete, so a run that cited `f3` still points at the same fact.

## Model providers

- **One interface, checked output.** Each provider only sends a request and streams back text. The shared `Provider.complete` parses that text against the step's Pydantic schema and raises `BadOutput` if it doesn't fit, so the pipeline never handles an unchecked reply, whichever provider produced it.
- **Strict schemas, written out in full.** Step replies forbid unknown fields and make every field required (a field that may be empty is `str | None` with no default), which is what the providers' structured-output modes expect. Pydantic puts nested models under `$defs`; `json_schema` inlines them because not every provider follows `$ref`.
- **Plain synchronous calls.** The interface calls Python through pywebview, which runs each call on its own thread, so a provider can block while it streams without freezing the window. That keeps each provider readable from top to bottom, with no event loop.
- **Retries.** Rate limits and server errors are retried up to three tries in all, waiting for the provider's Retry-After when given (capped at 30 seconds) and otherwise 2, then 4 seconds. A rejected key or a malformed reply isn't retried, because trying again gives the same answer.
- **The Demo provider is offline and deterministic.** It builds replies from the request itself, so the whole flow runs with no key or network, and end-to-end tests get the same output every time. Its score is a simple count of specific and vague bullets, and the interface says so.

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
