# How Tailor works

This is a tour of the backend, one part at a time, in the order a run touches them. Each section says what the part does, how it does it, and why it's built that way. File paths are relative to the repository root.

## The whole run in one paragraph

You paste a job posting. The app reads your LaTeX resume into editable pieces called slots and sends the resume and posting to a model three times. Score gives your base resume an ATS score and its top three red flags. Rewrite fixes those in your bullets, using anything you add in a note. Done scores the old and new versions side by side. Every rewrite the model proposes is checked in code before you can accept it: its numbers, names and skills must come from your own resume or facts bank, it may not lose any number, name or skill the original had, and it must follow a set of style rules. When you accept a rewrite, only that bullet's text changes in the file. The app compiles the result with Tectonic and shows the PDF. Export refuses anything longer than one page.

## Map of the code

| Part | File | Job |
| --- | --- | --- |
| Template engine | `app/core/tex.py` | Find the editable text in the resume and change only that |
| PDF compiler | `app/core/compile.py` | Run Tectonic and count pages |
| Grounding check | `app/core/grounding.py` | Block claims that aren't in the sources |
| Style rules | `app/core/style.py` | Block phrasing the app doesn't allow |
| Skills | `app/core/skills.py`, `skills.txt` | Find skills in text; count keyword coverage |
| Facts bank | `app/core/facts.py` | Store answers to "How many…?" questions |
| Pipeline | `app/core/pipeline.py` | The three model steps and the checks around them |
| Providers | `app/providers/` | Claude API, Claude Code, Gemini, Ollama, Demo |
| Bridge | `app/bridge.py` | Every command the interface can call |
| Window | `app/main.py` | Open the pywebview window |
| Storage | `app/core/db.py`, `app/core/secrets.py` | SQLite and the keychain |
| Facts import | `app/core/fact_import.py`, `app/importers/` | Suggest facts from a file or page |
| Jobs | `app/importers/jobs.py`, `places.py` | Internship listings from three GitHub repos |

## 1. Reading the resume: `tex.py`

The resume is a LaTeX file built on the Jake's Resume template. The app never rewrites the whole file. It finds the *slots*, the pieces of text it's allowed to change:

- the text of each `\resumeItem{...}` (a bullet),
- each argument of `\resumeSubheading{...}{...}{...}{...}` and `\resumeProjectHeading{...}{...}` (company, title, dates, place),
- the list after each skills label, as in `\textbf{Languages}{: Python, SQL}`.

**How it finds them.** `TexDoc.parse` walks through the file one character at a time, starting at `\begin{document}`. When it sees a command it knows, it reads the command's brace groups with `match_brace`, which counts `{` and `}` and skips anything after an unescaped `%` (a LaTeX comment). Each slot records where its text starts and ends in the file. Bullets are grouped under the heading above them, so the app knows which role or project each bullet belongs to.

**The skeleton.** Everything that isn't a slot is the skeleton: the preamble, the margins, the fonts, the section order. `verify_preserved` rebuilds the skeleton of an edited file and compares it with the original's, character for character. It also checks the number and kind of slots and the section titles. Every edit goes through this check, so no edit can change the layout. That's what "template safety" means in this app.

**Plain text in, escaped LaTeX out.** Models and the interface never see LaTeX. `tex_to_plain` turns a slot into plain text (`\textbf{x}` becomes `**x**`, `\&` becomes `&`), and `plain_to_tex` turns text back into LaTeX, escaping every special character. A model that writes `\section{Hacked}` gets `\textbackslash{}section\{Hacked\}`, which prints as text. Model output can't add a command.

**Hand edits.** You can type LaTeX into a bullet yourself. That text isn't escaped, so it's checked against an allowlist of inline commands (`\textbf`, `\emph`, `\textit`, `\underline`, `\href`, `\sim`, `\textbackslash`, `\textless`, `\textgreater`). Anything else, such as `\section`, `\vspace` or `\small`, is refused. Brace balance and the skeleton check alone don't catch everything: `\section{...}` hidden inside a bullet's braces keeps both intact, which is why the allowlist exists.

**Unchanged text keeps its bytes.** If a rewrite's text matches the original, the original bytes are kept. So applying no edits reproduces the file exactly, and a test checks that byte for byte.

**Removing a bullet** is the one structural edit. It deletes the whole `\resumeItem{...}` line, and the skeleton check knows to expect that.

## 2. Compiling the PDF: `compile.py`

The app compiles with Tectonic, a self-contained TeX engine that downloads the packages it needs and caches them. The app ships with its own copy.

**The XeTeX wrapper.** Tectonic runs XeTeX. The template has two lines, `\input{glyphtounicode}` and `\pdfgentounicode=1`, that only work in pdfTeX, so compiling the file directly fails with "Undefined control sequence". The app never edits your file to fix that. For each compile it writes the resume into a temporary folder as `resume.tex`, next to a small wrapper file, `tailor_main.tex`. The wrapper defines do-nothing versions of the two commands, but only if they're missing, and then `\input`s the resume. XeTeX already puts searchable Unicode text in the PDF, so ATS parsers can still read it.

**One run at a time.** On Windows, two Tectonic runs that build its format file at the same moment fail with "Access is denied". A `threading.Lock` around the Tectonic call makes compiles wait their turn. A test starts four compiles at once against a fake Tectonic that records overlaps, and the test fails when the lock is removed.

**Page count.** `pypdf` opens the PDF bytes and counts pages. More than one page is flagged, and export refuses it.

## 3. The truth checks

These are the rules that keep the resume honest. They're all code, so they run the same way whichever model wrote the text.

### Grounding: `grounding.py`

Every rewrite cites its sources: its own bullet, any other bullets, and any facts-bank entries. The heading of the bullet's role or project is always added too, so a bullet can name its own employer or stack. `check` then pulls three kinds of *claims* out of the new text:

- **Numbers**, including spelled-out ones ("two", "twice", "half"), `k` and `M`, percentages and ratios. `numbers()` turns each into a value, so "3k" matches "3,000" in the source.
- **Proper nouns:** capitalized words that aren't ordinary sentence starts, plus mixed-case words like `iPhone` or `DynamoDB`. "Built" at the start of a bullet doesn't count; "AWS" anywhere does.
- **Skills** from the lexicon, with their aliases, so "Golang" in a rewrite is backed by "Go" in the source.

Each claim must appear in the sources. There's no exception for small numbers: "5 components" is as much a claim as "5,000 users". A percentage needs a percentage in the source, and a ratio needs a ratio. So "cut calls by 75%" is blocked even when the source says "from 12,000 to 3,000": the math is right, but a hiring manager can't check a number the resume never states. The report lists each unsupported claim in plain words, such as `Number "40%" is not in the cited sources.`

### Never less specific: `dropped_specifics`

The grounding check run the other way round. The original bullet is the text being checked and the rewrite is its only source, so every number, name and skill in the original has to still be in the rewrite. A rewrite that turns "Added PostgreSQL indexes" into "Sped up the query" is blocked with `Drops "PostgreSQL" from the original.` A rewrite may add detail from its sources but may not lose any.

### Style: `style.py`

Regular expressions catch phrasing the app doesn't allow: em dashes between clauses, the stock words (leverage, seamless, robust, spearheaded, delve, synergy), comparisons with your own earlier work, and numbers with no unit or noun after them ("improved it by 3"). Three rules depend on the original wording: lists of three, "not X but Y" contrasts, and mentions of AI tools. Those only fire when the rewrite *adds* the pattern. If your original bullet already had it, the rewrite isn't blamed for keeping it.

### Skills and coverage: `skills.py`

`skills.txt` lists about 290 skills and their aliases, one per line. A leading `=` makes a name case-sensitive, so "go fast" doesn't count as Go. `contains_token` matches whole words only, so `Java` doesn't match inside `JavaScript` and `Node` doesn't match inside `Node.js`. One-letter names like C and R also need list context ("C, Java" or "in R"), so "Series C startup" doesn't count.

`extract_posting_skills` splits a posting's skills by its headings: under "Requirements" they're required, under "Nice to have" they're preferred, and a line saying "a plus" is preferred wherever it is. `coverage` then counts how many of the required skills you *have* are on the page. A skill only counts if your base resume or facts bank backs it up, so putting an invented skill on the page doesn't raise the number. This count is the steady one; the model's match score sits next to it as an opinion.

### Facts bank: `facts.py`

Under the score there's a box, "Anything to add?". `split_note` cuts what you type into one fact per line or sentence (fragments under three words are dropped), and each one goes into the facts bank before the rewrite runs. Rewrites can cite facts like any other source, so a number you add in the note can appear in a bullet and pass the grounding check. The run remembers which facts its note added. Undo removes them and checks again every rewrite that cited one, so a rewrite that relied on a removed fact is blocked again. The bank is a JSON file, written to a temporary file and then swapped in, so a crash can't leave half a file.

## 4. Talking to models: `app/providers/`

All five providers share one interface in `base.py`. A provider only does one thing: send a request and stream back text. The shared `Provider.complete` method then checks that text against the step's Pydantic schema. If the reply doesn't fit, it raises `BadOutput`. So the pipeline only ever gets checked data, whichever model wrote it.

A request has a fixed system prompt, a large context that repeats across steps (your resume), the step's own message, and the schema the reply must match. Rate limits and server errors are retried up to three tries in total; a rejected key isn't, because trying again gives the same answer.

- **Claude API** (`claude_api.py`) uses the `anthropic` SDK. The schema goes in `output_config.format`, so the reply is JSON that fits it. The instructions and resume are two system blocks with a cache marker on the resume, so the second and third steps read that shared part from the cache, which on Sonnet 5.5 costs a twentieth of the normal input price. It also asks for the server-side refusal fallback, and drops that option if the account doesn't accept it.
- **Claude Code** (`claude_code.py`) runs the `claude` command in print mode for each step, so the work counts toward a Claude subscription instead of API credits. It removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child's environment so `claude` uses the plan login, streams the output line by line, and reads the final `result` line. This one is for personal use on your own computer.
- **Gemini** (`gemini.py`) uses the `google-genai` SDK with `response_json_schema`. It skips the model's thinking text so only the answer streams to the screen.
- **Ollama** (`ollama.py`) talks to the local Ollama server over HTTP. Nothing leaves your computer.
- **Demo** (`demo.py`) answers from the request itself, with no network. It makes the whole app testable end to end.

## 5. The pipeline: `pipeline.py`

`Context` holds what doesn't change during a run: the parsed resume and its plain-text view, with bullet ids like `[b2]`. Each step builds a request around that.

1. **Score.** A small, fast call: the base resume's ATS score out of 100 and the top three red flags a recruiter for this company spots in ten seconds, with the section each is in. The facts bank isn't sent, since the score is of the page as it stands. A Claude provider runs this step on Sonnet even when Opus is chosen for the rest (`SCORE_MODELS` in `bridge.py`). A red flag about adding a summary is dropped.
2. **Rewrite.** Every Experience and Projects bullet goes to the model with the red flags, the missing keywords, the facts bank and the posting. Missing keywords aren't a model's opinion: `missing_keywords` reads them from the coverage count, as the posting's skills you can back up but don't show. The prompt asks for changes only where a red flag or missing keyword calls for one, plain and professional, leading with measurable impact in the Google XYZ form, and never less specific or technical. Each proposal comes back with its sources and a reason. `Context.check` runs grounding, the specifics check and style on each one and marks it `ok`, `blocked` or `unchanged`. Blocked ones go back to the model **once**, with the checker's reasons, and a second failure stays blocked so you can see why.
3. **Done.** One call scores the base resume and the tailored one (your accepted changes in place) with the same rubric as Score. Scoring them in separate calls let run-to-run noise decide the result: a resume could drop from 58 to 54 after changes that helped. In one call both numbers come from the same reading. `FinalScore.scored` records the texts that were scored, so the interface can tell when a later decision has made the numbers stale and offer to score again.

Score and Done share one rubric (`RUBRIC`), so their numbers mean the same thing.

Three more things are worked out in code, not by a model:

- **Skills order.** At export, each skills line is reordered so the posting's required skills come first. Nothing is added or removed.
- **Trimming hints.** If the PDF runs over a page, the app lists bullets whose last line is short (at about 113 characters a line), since cutting a few words there saves a whole line.
- **Cost.** `pricing.py` turns token counts into dollars for the Claude API. The other providers cost nothing per token.

## 6. The window and the bridge: `main.py`, `bridge.py`

**The window.** `main.py` opens a pywebview window, which uses the system's own web view (WebKit on macOS, WebView2 on Windows). The interface is a React app that Vite builds into one self-contained `index.html`, loaded from a `file://` URL. There's no local web server and no open port.

**One entry point.** The page reaches Python through a single method, `Bridge.call(command, args)`. It looks the command up in the `COMMANDS` list, converts the argument names from the page's `camelCase` to Python's `snake_case`, runs the method on `Backend`, and returns `{"ok": result}` or `{"error": {"kind", "message"}}`. Unknown commands are refused. Keeping one door means error handling and the list of allowed commands live in one place.

**Threads.** pywebview runs each call on its own thread, so a 30-second model step doesn't freeze the window. Two calls can touch the same run at once, for example if you accept a bullet while Done is scoring. So every change goes through `_change_run`, which takes a lock, loads the latest saved state, applies the change, and saves. A slow step that finishes later doesn't overwrite a decision you made while it ran.

**Streaming.** A streaming step gets a channel id from the page. Python sends each piece of text with `window.run_js("window.__tailorEmit(id, event)")`, and the page shows it as it arrives. `json.dumps` escapes the text, so a posting can't break out of the script.

**Run state.** `RunState` holds everything about one run: the posting and its link, the score, the facts its note added, each rewrite and your decision on it, the final score, coverage, step costs, page count and export path. It's saved to SQLite after every change, so you can close the app and reopen any run from the history list. Runs saved by earlier versions of the steps still open: their red flags and ATS scores carry over. Each run also keeps a copy of the base resume it started from, so replacing your resume later doesn't break an old run.

## 7. Storage: `db.py`, `secrets.py`

**SQLite** through Python's `sqlite3` module, with plain SQL and no ORM. Tables hold runs, applications (the tracker), step logs, blocked claims, the manual-baseline stopwatch and settings. A run's full state is stored as JSON next to the summary columns the history list needs. `PRAGMA user_version` tracks which migrations a database has had, and each new migration runs once on startup. One connection is shared, with a lock around every statement, because calls arrive on several threads.

**API keys** go in the system keychain through `keyring`: the macOS Keychain or the Windows Credential Manager. They never go in a file, a log or the interface. The interface only sees a masked form like `sk-ant…a1b2`.

**The data folder** is the OS app-data folder by default. You can move it in Settings: the app copies your data to the new folder, records the choice in a small file it reads at startup, and leaves the old copy in place.

## 8. Facts import: `fact_import.py`, `app/importers/`

You can drop a file (PDF, Word, text or Markdown) or paste a link to your site. `files.py` reads the text with `pypdf` or `python-docx`, and `web.py` fetches the page with `httpx2` and keeps its readable text with `beautifulsoup4`, listing any links that look like a resume PDF. The selected provider then suggests short, specific facts. Each suggestion goes through the same grounding check as a rewrite, with the document as its source, so a number the document doesn't contain is flagged. Then `covered_by` compares each suggestion with what you've already said: every bullet on the base resume with its heading, every skills line and every saved fact. If one of them supports all the suggestion's numbers, names and skills (the same grounding check again) and shares most of its words, the suggestion adds nothing new. It's shown in a closed "Already on your resume" group instead of with the new ones. Nothing is saved until you accept a suggestion, as it is or after editing it.

## 8b. Jobs: `jobs.py`, `places.py`

The Jobs screen lists internships from three GitHub repos, written into the code: SimplifyJobs/Summer2027-Internships, vanshb03/Summer2027-Internships and speedyapply/2027-SWE-College-Jobs. The app downloads their files from `raw.githubusercontent.com`, so it needs no GitHub account or token.

Simplify keeps every listing it has ever posted in `.github/scripts/listings.json`, with an `active` flag, and vanshb03 keeps one in the same format, so `parse_listings_json` reads both and keeps the active, visible ones. SpeedyApply publishes no data file, only Markdown tables in `README.md` (US internships) and `INTERN_INTL.md` (everywhere else). `parse_readme` reads those, finding the columns by their header names because one table has a Salary column and the others don't. The same function reads Simplify's HTML table if its JSON ever can't be loaded, and follows Simplify's markings: "↳" means the same company as the row above, and 🔒 means closed. A README only says how old a posting is ("3d"), so the date is counted back from the day of the fetch.

The same posting often appears in more than one repo. `canonical_url` strips tracking parameters such as `utm_source`, and `merge` keeps one entry per address with every source listed. vanshb03 links through its own short links, so its addresses never match the others; `merge` also treats the same company and title from two different lists as one posting when their places overlap.

Each listing carries two flags. `advanced_degree` marks a role only open to Master's or PhD students: Simplify's JSON lists the degrees a role accepts, its README puts 🎓 on the role, and otherwise the title decides (PhD, Master's, MBA, doctoral). A role that also takes a Bachelor's isn't flagged. The screen hides flagged roles until you ask for them. `us` says whether any of the listing's places is in the US, from `places.is_us`. That's rules rather than a list of cities: a state name or code, DC or Puerto Rico, the country's names, remote in the US, and a few aliases for cities written without a state (NYC, SF, Chicago and so on). Anything naming Canada or a province isn't US, since "CA" also means California. Typing "United States", "US" or "USA" in the location filter then matches every listing with `us` set. The tests check the rules against location strings copied from the three lists.

`JobsCache` saves the result as `jobs.json` in the data folder, so the list opens offline. If one repo can't be reached, its listings from the last good fetch stay. Each listing records when the app first saw it. Opening the screen starts a visit and remembers the one before, and a listing first seen after that earlier visit gets a New badge. Nothing is new on the very first visit. The page refreshes by itself when the list is more than an hour old.

"Tailor for this" tries to read the posting from its link with the same page reader as the facts import. Sites such as Workday build the posting in the browser, so the reader gets almost nothing back. Under 600 characters counts as a failure, and the Tailor screen opens with the company and role filled in and asks for a paste. "Mark applied" adds the listing to the tracker with its link, and a second click updates the same entry.

## 9. Packaging

PyInstaller bundles Python, the app, the built interface and Tectonic into `Tailor.app` on a Mac and a folder on Windows. CI signs the Mac app ad hoc, wraps it in a `.dmg`, and builds a Windows installer with Inno Setup. Before uploading, it runs `Tailor --self-test`, which checks the bundled files and compiles a small document with the bundled Tectonic. It then opens the real window with a throwaway data folder, waits for the interface to report that it's talking to Python, makes one call through the bridge and closes.

## 10. How it's tested

- **Python, with pytest** (`tests/`): every truth check has its own tests, and the template engine is checked byte for byte. Providers run against a local stand-in for each API, using the real SDKs. The Claude Code provider runs against a fake `claude` script. The bridge tests run whole runs with the Demo provider through to an exported one-page PDF.
- **The interface, with Vitest and Playwright** (`ui/`): unit tests for small pieces such as the preview fit, browser tests against an in-memory mock, and one test that opens the built page from `file://` against the real Python backend.
- **CI** runs the Python tests on Linux, macOS and Windows, the interface tests on Linux, and then builds and self-tests both installers.

## Questions you might get

**How do you stop the model from making things up?** The model can propose anything, but code checks every number, name and skill against the sources the rewrite cites, and blocks what it can't find. The check doesn't trust the model's citations either: a citation only counts if the cited text really contains the claim.

**Why not let the model edit the LaTeX?** Because then it could change fonts, margins or sections. The model only ever sees and writes plain text for one slot at a time, and that text is escaped before it goes into the file. A separate check compares the whole layout before and after every edit.

**Why one bridge method instead of exposing every function?** One entry point gives one list of allowed commands, one place to convert arguments and one place to turn exceptions into errors the interface understands. Nothing else on the object can be called from the page.

**What happens if two things change a run at the same time?** Changes go through a lock and always apply to the latest saved state, so neither one is lost.

**Why SQLite without an ORM?** The data is small, the queries are simple, and plain SQL is easy to read and explain. Migrations are a numbered list.

**Why is coverage counted in code and not by the model?** So the same resume and posting always give the same number, and so a skill you don't have can't raise it.
