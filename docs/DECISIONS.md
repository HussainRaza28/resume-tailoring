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
- **Claude API through the official SDK.** `anthropic` handles the request format, streaming events and error types, so the provider is mostly a mapping from SDK results to the app's own errors. The SDK's built-in retries are off (`max_retries=0`) so every provider retries the same way, in `Provider.complete`.
- **Claude API defaults.** The default model is `claude-sonnet-5-5`, which gives strong rewrites at a lower price per run than Opus. The instructions and the base resume are two system blocks with a cache breakpoint on the resume, so the red flags, rewrite and review steps after the first read that shared prefix from the cache. Effort is left at the model's default unless set in Settings.
- **Refusal fallback.** Requests send `fallbacks: "default"` with its beta header, so a request the model's safety checks decline is rerun on a fallback model in the same call instead of failing the step. If an account rejects the option, the provider drops it and sends the request again.
- **Gemini through the `google-genai` SDK**, with `response_json_schema` for structured output. The default model is `gemini-flash-latest`, an alias that follows Google's current Flash model and is covered by the free tier. The instructions and resume go first, in the system instruction, so Gemini's automatic caching can reuse them across steps. Thinking parts are skipped, so only the answer streams to the interface, but thinking tokens still count toward the cost. `max_output_tokens` is doubled for the same reason: thinking uses up the same limit.
- **`httpx2` for plain HTTP.** Both AI SDKs already depend on `httpx2`, a drop-in fork of `httpx` with the same API, so Ollama and the web import use it too instead of adding a second HTTP library.
- **Ollama over its local HTTP API.** It has no official Python SDK in the stack, and the `/api/chat` call is one POST that streams a JSON object per line, so plain `httpx2` keeps it short. The context window is raised to 16,384 tokens because Ollama's default is too small for the instructions, the resume and a posting together. A missing model gets a message with the `ollama pull` command, and a refused connection says that Ollama isn't running.
- **Claude Code provider ("Claude Code (Pro plan)").** It runs each step through the `claude` command in print mode, so the work is billed to a Claude subscription instead of API credits. It's for personal use: it drives the user's own signed-in copy of Claude Code on their own computer, and it isn't a way to serve other people from one subscription.
- **Its flags come from `claude --help`.** `--output-format stream-json` with `--include-partial-messages` streams text as it's written (print mode refuses stream-json without `--verbose`), `--json-schema` asks for structured output, `--system-prompt` replaces Claude Code's own instructions with the app's, `--tools ""` turns off the built-in tools, and `--no-session-persistence` keeps these runs out of the user's session list. The prompt goes in on standard input, so a long posting can't hit a command-line length limit.
- **The plan login, never an API key.** `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed from the child's environment, because either one makes `claude` bill an API account. The child runs in an empty temporary folder so no project settings or files leak into a step.
- **Structured output with a fallback.** The final `result` line carries `structured_output` when the schema was met. If it's missing, the result text is checked against the same schema instead, and the prompt ends with "Reply with JSON only", so either path gives validated data.
- **Finding `claude`.** A Mac app opened from Finder doesn't get the shell's `PATH`, so besides `PATH` the provider checks `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin`. Settings shows whether it's installed and signed in, from `claude --version` and `claude auth status --json`.
- **Tests use a fake `claude`.** A small script records the arguments, environment, folder and input it gets, and prints the same stream-json lines. These tests are skipped on Windows, where a `.cmd` stand-in can't receive an argument with newlines in it.
- **A refusal or a cut-off reply is an error,** reported as `BadOutput` with the reason, because half a JSON reply can't be checked against the schema.
- **The Demo provider is offline and deterministic.** It builds replies from the request itself, so the whole flow runs with no key or network, and end-to-end tests get the same output every time. Its score is a simple count of specific and vague bullets, and the interface says so.

## The tailoring steps

- **Three model steps.** Red flags, then rewrite, then review, each a separate call with its own schema. Keeping them separate lets each one stream into its own part of the interface, and lets a step be retried or rerun without redoing the others.
- **The base resume is the cached context.** Every step sends the same system instructions and the same plain-text resume (with bullet ids) first, then the step's own message, so providers that cache a repeated prefix only pay full price for it once per run.
- **One automatic repair.** Blocked rewrites go back to the model once, with the checker's reasons. A second failure stays blocked and the user sees why. A retry that fails outright keeps the first attempt's results, since those are already checked. The "unsupported claims caught" count comes from the first attempt, before the retry, so it measures what the model tried to add.
- **Every bullet gets a result.** A bullet the model skipped comes back unchanged, and a proposal for something that isn't a rewritable bullet (a skills line, an unknown id) is ignored, so the interface always shows one card per bullet.
- **A rewrite always cites its own bullet.** If the model leaves its own id out of `sources`, it's added before the check.
- **Summary advice is dropped in code.** A red flag that says to add a summary, objective or profile is removed, and the review drops any skipped section with that kind of title. This sits on top of the locked section order in the template engine.
- **Questions aren't asked twice.** A question the facts bank already answered for the same bullet is cleared before the user sees it.
- **The review scores the resume as it stands,** with accepted rewrites in place, and a suggested rewrite is compared with that current text.
- **Skills reordering is done in code at export:** within each skills line, required matches first, then preferred, then other mentions, then everything else in its original order. Nothing is added or dropped, and an honors or awards line is left alone.
- **One-page trimming hints.** When the PDF runs over a page, the app lists bullets whose last line is shortest, using about 113 characters per bullet line (measured on the compiled sample), so a small cut saves a whole line. It's an estimate; the next compile is the real check.
- **Model text is tidied** before checking: a leading bullet mark, wrapping quotes and a final period are removed, because the template's bullets have none.
- **Cost per run.** `pricing.py` has per-token prices for the Claude API models. Claude Code bills the user's plan, Gemini's free tier, Ollama and the Demo provider cost nothing, and an unknown model shows a dash rather than a guess. Cache writes cost 1.25 times the input price, and cache reads are priced per model.

## Desktop window and bridge

- **pywebview with one entry point.** The page reaches Python through a single method, `Bridge.call(command, args)`, which runs a command from the `COMMANDS` list and answers `{ok}` or `{error: {kind, message}}`. With one entry point, argument names, error handling and the allowed commands all live in one place, and no other method on the object can be reached from the page. A test checks that `call` is the only public attribute.
- **No web server, no open port.** Vite builds the interface into one self-contained `index.html`, with scripts, styles, fonts and pdf.js inline (`vite-plugin-singlefile`). The window loads it from a `file://` URL, and pywebview's own HTTP server stays off. The webviews block module scripts fetched from `file://`, but scripts written inline in the page run fine.
- **pdf.js on the main thread.** Loading pdf.js's worker module into the page lets it run without a separate worker file, which a single-file build can't ship. It only ever draws one page.
- **Streaming through channels.** A streaming command gets a channel id from the page. Python sends each event with `window.run_js("window.__tailorEmit(id, event)")`. `run_js` doesn't wait for the page, so streaming never slows a step, and `json.dumps` escapes the text so a posting can't break out of the script.
- **Calls run on their own threads.** pywebview runs each call on a new thread, so a long model step doesn't freeze the window. Changes to a run go through one lock and always apply to the latest saved state, so a decision made while a step runs isn't overwritten when the step finishes.
- **The page waits for the bridge.** pywebview adds `window.pywebview.api` just after the page loads and then fires `pywebviewready`. The window URL carries `?desktop=1`, so the page waits for that event. Without the flag, in a plain browser, it uses an in-memory mock backend with the fake sample data, for screenshots and browser tests.
- **The preview fits its box.** The PDF page is scaled by the smaller of the pane's width and height ratios (`fitScale`), so the whole page shows with no scrolling or panning, and a resize observer redraws it when the pane changes size. Fitting by width alone made a short, wide pane cut off the bottom of the page.
- **The PDF is named after the person on the resume.** The name comes from the resume's `\Huge` header line, so nothing personal is built into the app: the sample exports as `Jordan_Sample_Resume_<Company>.pdf`.
- **Two kinds of interface tests.** Playwright drives the page against the mock backend for the interactions. A second test opens the built `index.html` from `file://` against the real Python bridge (Demo provider and Tectonic) and runs the flow to an exported PDF, checking on the way that the preview fits the pane at three window shapes. A test-only HTTP front (`tests/bridge_server.py`) stands in for pywebview there. The app itself has no server.

## Storage

- **SQLite through `sqlite3`, with plain SQL.** Runs, applications, step logs, grounding blocks, the manual baseline and settings each have a table. A run's full state is stored as JSON next to the summary columns that the history list and the numbers need, so reopening a run restores it exactly. `PRAGMA user_version` records which migrations a file has had.
- **One connection behind a lock.** Calls arrive on several threads. One connection opened with `check_same_thread=False`, and every statement run under a lock, is simpler than a connection per thread, and the app's writes are small.
- **API keys in the system keychain** through `keyring`: the macOS Keychain and the Windows Credential Manager. The interface only gets a masked form, the first 6 and last 4 characters.
- **The data folder** is the OS app-data folder (`~/Library/Application Support/Tailor/private` on a Mac, `%APPDATA%\Tailor\private` on Windows). `TAILOR_DATA_DIR` overrides it, for development against the gitignored `data/private/`.

## Settings and data

- **Each run keeps the resume it started from.** The base resume's text is stored with the run (migration 2 adds the column). A run's bullet ids point into that text, so replacing the base resume in Settings can't break or change an earlier run. Runs saved before the column existed fall back to the current base resume.
- **Moving the data folder copies, then switches.** The chosen folder is recorded in `location.json` beside the default data folder, where the app looks before opening anything. An empty folder receives the data as it is, a folder with other files in it gets a `Tailor` folder inside, and a folder that already holds Tailor data is used without copying. The old copy is left in place, so a failed or mistaken move loses nothing. `TAILOR_DATA_DIR` still wins, and the app refuses to move data while it's set.
- **Line endings are kept.** `.tex` files are read with `newline=""`. `Path.read_text` turns Windows CRLF into LF, which changed a resume saved on Windows on its way in.
- **Reduce Motion follows the system setting** through `prefers-reduced-motion`, so there's no separate switch in the app to fall out of step with it.

## Facts import

- **Files and pages in, suggestions out, nothing saved without approval.** A dropped PDF, Word, text or Markdown file, or a web page, is turned into text, and the selected provider suggests short, specific facts from it. The interface saves only the ones the user accepts, as they are or edited.
- **Suggestions are checked like rewrites.** Every number, name and skill in a suggested fact must appear in the document, using the same grounding check as rewrites. A suggestion that fails shows why and can't be accepted as it is. Editing it makes it the user's own statement, which the facts bank exists to hold. Suggestions already in the bank are marked, and repeats are dropped.
- **Libraries.** `pypdf` reads PDFs (it's already used for page counts), `python-docx` reads Word files, including table cells, where resumes often keep their content, and `beautifulsoup4` with Python's built-in HTML parser pulls the readable text out of a page and drops scripts, styles, navigation and footers.
- **Resume links on a page.** Links whose address ends in `.pdf` or whose text says resume or CV are listed, so a portfolio page can lead on to the resume itself. Reading one is the user's choice.
- **Limits.** Files over 10 MB are refused before they're sent. Text over 60,000 characters is cut, and the interface says so instead of quietly dropping the rest. A scanned PDF with no text says that there's nothing to read.
- **Dropped files cross as base64.** The page reads a dropped file with `FileReader` and sends its bytes to Python. Webviews don't give the page a dropped file's path, and sending the bytes works the same in every webview.
- **Web requests name the app, not the user.** The user agent is a plain `Tailor/0.1` string. Only `http` and `https` addresses are fetched.

## Interface blocks

- **Bencho's code and comments are kept as written.** `ui/src/blocks/SOURCE.md` lists each block, where it came from and its license, and whether the file is Bencho's original or a version written for this app from the public listing.
- **Tokens are mapped on each block's own root.** A Bencho block reads tokens such as `--fill-on`, `--fill-slab` and `--font-ui`. Each one is set on the block's root element to the app's own token (`--fill-on: var(--wake-ink)`, `--signal: var(--accent)` and so on), so Bencho's CSS stays as written and nothing new becomes global.
- **The upload dropzone gets a real-file mode.** Bencho's block is a demo that uploads pretend files from a tray. With an `onFile` prop it takes real drops and clicks instead, hides the tray, and holds its bar at 90% until the file has been read. The additions are marked `app:` in the file. Without the prop it's Bencho's block unchanged.
- **Two ASCII wakes.** Bencho's ASCII wake follows the pointer, which suits the empty state. A loader that drives the same effect by itself while a step runs is a separate, rebuilt file.

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
