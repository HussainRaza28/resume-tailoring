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
| Style rules | `app/core/style.py` | Flag phrasing the app warns about |
| Bold | `app/core/bold.py` | Keep the template's bold through a rewrite |
| Skills | `app/core/skills.py`, `skills.txt` | Find skills in text; count keyword coverage |
| Facts bank | `app/core/facts.py` | Store answers to "How many…?" questions |
| Pipeline | `app/core/pipeline.py` | The three model steps and the checks around them |
| Lines | `app/core/lines.py` | Every line of the resume, and which parts are protected facts |
| Note instructions | `app/core/instructions.py` | Turn "change X to Y" notes into a change to one line |
| Providers | `app/providers/` | Claude API, Claude Code, ChatGPT (Codex), Gemini, Ollama, Demo |
| Finding CLIs | `app/providers/cli_paths.py` | Find `claude` and `codex` outside the terminal's `PATH` |
| Bridge | `app/bridge.py` | Every command the interface can call |
| Window | `app/main.py` | Open the pywebview window |
| Storage | `app/core/db.py`, `app/core/secrets.py` | SQLite and the keychain |
| Facts import | `app/core/fact_import.py`, `app/importers/` | Suggest facts from a file or page |
| Jobs | `app/importers/jobs.py`, `places.py` | Internship listings from three GitHub repos |
| Autofill export | `app/core/autofill.py` | The base resume as a profile for the extension |
| Autofill extension | `extension/src/` | Fill job applications in Chrome from a saved profile |

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

The grounding check run the other way round. The original bullet is the text being checked and the rewrite is its only source, so every number, name and skill in the original has to still be in the rewrite. A rewrite that turns "Added PostgreSQL indexes" into "Sped up the query" gets the warning `Drops "PostgreSQL" from the original.` A rewrite may add detail from its sources, and losing any is flagged.

### Style: `style.py`

Regular expressions catch phrasing the app doesn't allow: em dashes between clauses, the stock words (leverage, seamless, robust, spearheaded, delve, synergy), comparisons with your own earlier work, and numbers with no unit or noun after them ("improved it by 3"). Three rules depend on the original wording: lists of three, "not X but Y" contrasts, and mentions of AI tools. Those only fire when the rewrite *adds* the pattern. If your original bullet already had it, the rewrite isn't blamed for keeping it.

### Skills and coverage: `skills.py`

`skills.txt` lists about 290 skills and their aliases, one per line. A leading `=` makes a name case-sensitive, so "go fast" doesn't count as Go. `contains_token` matches whole words only, so `Java` doesn't match inside `JavaScript` and `Node` doesn't match inside `Node.js`. One-letter names like C and R also need list context ("C, Java" or "in R"), so "Series C startup" doesn't count.

`extract_posting_skills` splits a posting's skills by its headings: under "Requirements" they're required, under "Nice to have" they're preferred, and a line saying "a plus" is preferred wherever it is. `coverage` then counts how many of the required skills you *have* are on the page. A skill only counts if your base resume or facts bank backs it up, so putting an invented skill on the page doesn't raise the number. This count is the steady one; the model's match score sits next to it as an opinion.

### Facts bank: `facts.py`

Under the score there's a box, "Anything to add?". `split_note_parts` cuts what you type into one piece per line or sentence. A piece that asks for a change ("change graduation date to 2027", "add Compilers to coursework", "fix my dates") is kept on the run as typed, and the rewrite applies it (see below). Every other piece is a fact and goes into the facts bank before the rewrite runs. A note that asks for a skill ("add Node.js to my skills") is saved as the skill it names ("Skills: Node.js"); other fragments under three words are dropped unless they name a skill. The rewrite prompt lists the note's facts separately, and `Context.check` counts them as sources even when the model doesn't cite them, so a number or skill you add in the note can appear in a rewrite and pass the grounding check. The run remembers which facts its note added and which changes it asked for. Undo removes the facts and checks every rewrite again, so a rewrite that relied on a removed fact is blocked again, and it takes back every change the note asked for.

**Lines and protected facts: `lines.py`.** Every slot of the resume is a line with a kind. Bullets (in every section), the coursework line, skills lines, a project heading's tech stack and an honor's wording are prose the model may change. School, employer, degree line, job title, dates and location are facts, and so are the protected pieces inside prose lines: a date or GPA, the "Relevant Coursework:" label, a project's name, an honor's name and its numbers. Each line lists those pieces, and `protected_changes` finds any a rewrite lost. Fact-only lines are never sent to the model. If the model changes one anyway, or loses a protected piece of a prose line, `Context.check` blocks it with the reason, unless a note asked for that change.

**Changes asked for in a note: `instructions.py`.** `parse_instruction` reads "change X to Y", "replace X with Y" and "add X to <line>". It finds the line by what the note calls it (graduation date, GPA, degree, job title, dates, location, coursework, a project's stack, a skills label, scoped by a company, school or project name when the note gives one) or by text the note quotes from the resume. It changes only what the note names: a bare year replaces the year in "Expected May 2028", "GPA to 3.4" replaces the number after GPA, a degree replaces the first part of "Degree | Minor | GPA", an added course or tool goes at the end of the list. When more than one line fits, or the note doesn't say what to write ("fix my dates"), nothing changes and the item asks which line, listing the candidates. Facts such as "Set up 20 laptops for a club" start like instructions, so set, make and fix only count when they name a kind of line or say what to change it to. At rewrite time `apply_instructions` applies the changes in code, one after another, and checks each changed line with the note as its source. Those lines start accepted and aren't sent to the model: the person's instruction beats the model's judgment. The bank is a JSON file, written to a temporary file and then swapped in, so a crash can't leave half a file.

## 4. Talking to models: `app/providers/`

All five providers share one interface in `base.py`. A provider only does one thing: send a request and stream back text. The shared `Provider.complete` method then checks that text against the step's Pydantic schema. If the reply doesn't fit, it raises `BadOutput`. So the pipeline only ever gets checked data, whichever model wrote it.

A request has a fixed system prompt, a large context that repeats across steps (your resume), the step's own message, and the schema the reply must match. Rate limits and server errors are retried up to three tries in total; a rejected key isn't, because trying again gives the same answer.

- **Claude API** (`claude_api.py`) uses the `anthropic` SDK. The schema goes in `output_config.format`, so the reply is JSON that fits it. The instructions and resume are two system blocks with a cache marker on the resume, so the second and third steps read that shared part from the cache, which on Sonnet 5.5 costs a twentieth of the normal input price. It also asks for the server-side refusal fallback, and drops that option if the account doesn't accept it.
- **Claude Code** (`claude_code.py`) runs the `claude` command in print mode for each step, so the work counts toward a Claude subscription instead of API credits. It removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child's environment so `claude` uses the plan login, streams the output line by line, and reads the final `result` line. A watchdog (`watchdog.py`) stops the command, with its whole process tree on Windows, when a call passes 600 seconds or prints nothing for 240, and the step fails with that reason instead of hanging. This one is for personal use on your own computer.
- **ChatGPT (Codex)** (`codex.py`) does the same with OpenAI's `codex exec`, so the work counts toward a ChatGPT plan. The step's schema goes in a file passed with `--output-schema`, the prompt goes in on standard input, and `-o` names a file Codex writes its final answer to, which is what the app reads. `--json` events stream the answer to the screen and report token counts and a failed turn. It runs read-only (`-s read-only`) in an empty temporary folder, without the user's own Codex config, and with `OPENAI_API_KEY` and `CODEX_API_KEY` removed so the ChatGPT sign-in is used. `status` reads `codex login status`: "Logged in using ChatGPT" counts as signed in, and an API key sign-in doesn't.
- **Gemini** (`gemini.py`) uses the `google-genai` SDK with `response_json_schema`. It skips the model's thinking text so only the answer streams to the screen.
- **Ollama** (`ollama.py`) talks to the local Ollama server over HTTP. Nothing leaves your computer.
- **Demo** (`demo.py`) answers from the request itself, with no network. It makes the whole app testable end to end.

## 5. The pipeline: `pipeline.py`

`Context` holds what doesn't change during a run: the parsed resume and its plain-text view, with bullet ids like `[b2]`. Each step builds a request around that.

1. **Score.** A small, fast call: the base resume's ATS score out of 100 and the top three red flags a recruiter for this company spots in ten seconds, with the section each is in. The facts bank isn't sent, since the score is of the page as it stands. A Claude provider runs this step on Sonnet even when Opus is chosen for the rest (`SCORE_MODELS` in `bridge.py`). A red flag about adding a summary is dropped.
2. **Rewrite.** Every line the model may change goes to it, with the advice items (the red flags, then the missing keywords, numbered a1, a2, ...), the note's facts (n1, n2, ...), the changes already made from the note, each line's protected pieces, the facts bank and the posting. It works through the advice, then the notes, then its own obvious improvements, and replies with the lines and an `items` report: for each item, whether a line it changed addresses it, which lines, and why. Missing keywords aren't a model's opinion: `missing_keywords` reads them from the coverage count, as the posting's skills you can back up but don't show. The prompt asks for changes only where a red flag or missing keyword calls for one, plain and professional, leading with measurable impact in the Google XYZ form, and never less specific or technical. Each proposal comes back with its sources and a reason. `Context.check` runs grounding, the specifics check and style on each one and marks it `ok`, `blocked` or `unchanged`. Bold survives too: `keep_bold` (`app/core/bold.py`) puts `**…**` back on any phrase that was bold in the original and is still there, and lets the model bold one short phrase for the key result, made only of words already in the bullet. Other new bold is dropped, and the checks read the text without markers. Export writes the markers back as `\textbf`, and the comparison shows them as real bold. Only grounding blocks: a claim the sources don't back up goes in `reasons`. Style findings and dropped details go in `warnings`, which show under the bullet with Accept still enabled. Rewrites that are blocked or have warnings go back to the model **once**, with the findings. A retry that is still blocked is thrown away, and one with warnings replaces the first attempt only if it has fewer. In the same retry, when the first answer changed nothing or added none of the missing keywords, the unchanged lines go back with the advice as a numbered list it must address; a line returned with its own text is no edit. `item_results` turns the report into one result per item, checked against the lines in code: a keyword is Applied only when a changed line now shows it, a note's fact only when a changed line cites it, and a red flag when a line the model named came back changed and allowed. Otherwise it's Blocked (with the checker's reasons), Couldn't act (with the model's reason, or "there's no line in Header the rewrite can change" when the flag's section has nothing editable), or for an unclear note, Which line?. `summarize` counts what happened to each line (changed, asked for, blocked and why, protected facts blocked, same text, skipped, bold or order only, answers for ids that aren't lines, a failed retry) and writes the sentence the Rewrite view shows. "No changes needed" is only used when there was no advice and no note.
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

## 8c. The Autofill extension: `extension/`

A separate Chrome extension that fills job applications from a profile kept in the browser. It has three parts. `options.ts` is the profile page, built from one list of sections in `profileForm.ts` and saved with `chrome.storage.local`. Plain fields are drawn from that list, and roles, schools and languages get list editors with add, move and remove buttons; the form is the page's state, and `readForm` reads the whole profile back out of it. `popup.ts` is the toolbar popup. `content.ts` runs in the job site's page and adds the floating Autofill button. The pages use the app's own tokens and fonts, and the profile header has a small ASCII wake (`wake.ts`, the app's block redrawn without React).

The profile (`profile.ts`) holds lists: roles with dates and bullets, schools, skills, languages and links, plus the common answers and the self-identification answers. The top of the profile follows Workday's My Information page: legal name, preferred name, contact, address. `withDefaults` upgrades an older saved profile: a single school becomes the first education entry, the phone type and country move from the questions to the contact details, one sponsorship answer fills both "now" and "in the future", and a start date written as text becomes a date.

**Import from Tailor.** The app's Settings has Export for Autofill (`app/core/autofill.py`). It reads the base resume with the same `TexDoc` parser the pipeline uses: the header's name, phone and links, each education and experience heading's fields (dates are read as "YYYY-MM"; a heading with the title first is detected by job-title words), the bullets as plain text, and the skills lines, plus the facts bank. The extension's `importTailor.ts` checks the file's format, merges it (the resume replaces contact details, roles, schools, skills and facts; everything a resume doesn't hold is kept) and lists each change for the person to apply or cancel. A copy of the app's export of the sample resume sits in the extension's test fixtures, and a Python test keeps it equal to what the app produces, so both sides are tested on the same file.

The filling is in `src/fill/`. `engine.ts` walks every visible field in page order. For each one it asks what the field wants: the site's own field name first (`sites.ts`), then the label (`keys.ts`, ordered rules such as "first name" before "name"). It then answers from the profile. `dom.ts` does the setting in a way React forms notice: the browser's own value setter plus `input` and `change` events, a `DataTransfer` for the resume, and a click on the right option for dropdowns that open a list. Choices are picked by meaning, so "Decline to answer" in the profile matches "I don't wish to answer" or "Decline To Self Identify" on the form.

Entry fields are answered by position: the n-th field asking for a company gets the n-th role (`ENTRY_KEYS` in `keys.ts`), which is how Greenhouse's employment blocks are filled. Workday's My Experience needs more, so a site can run its own step before the general pass (`Site.before`). Workday's (`workday.ts`) finds each section by its heading, finds the entries already on the page by a field every entry has (`jobTitle`, `school` or the older `schoolName`, `language`, `url`), and matches them to the profile by company or school. It first presses the section's `add-button` for each profile entry still missing, waiting for each new entry to render, and only then fills, so nothing is typed into an entry Workday redraws when the next one is added.

Workday's widgets are in `workdayWidgets.ts`, written against real pages saved from a Workday application (sanitized copies in `extension/test-fixtures/workday_*.html`). A date is a `dateInputWrapper` of spinbutton inputs with a display beside each; a value set on the input shows but isn't committed, so `setWorkdayDate` types each digit as keydown, input and keyup, blurs, and counts the date only when the display or `aria-valuenow` shows it and the field has no error. School, Field of Study, Skills, How Did You Hear and Country Phone Code are search lists (`data-uxi-widget-type="selectinput"`): `pickFromSearch` types, opens the list with Enter, takes the options that weren't on the page before, picks exact, then starts with, then contains, shortest first, and waits for a `selectedItem` chip; with no match it clears what it typed. State, Phone Device Type, Country and Degree are buttons that open a listbox: `pickFromListbox` takes only options that appeared after the click, because a chosen chip elsewhere on the page has `role="option"` too, and checks the button shows the choice. `aliasesFor` lets "Mobile" find "Home Cellular" and "B.S." find "Bachelors". After each section, any field it filled that Workday flags (an error, `aria-invalid`, an uncommitted date, a list with no chip) is filled once more and then reported as filled but not accepted; `workdayAfter` does the same check after the general pass. Report labels come from the field's label and entry ("Work Experience 1: From"), never from a Workday `aria-label`, which holds the answer. `format.ts` adds https:// to links that lack it and "• " to each role description line that has no marker. Fields that step touched are skipped by the general pass. The same step ticks My Information's "I have a preferred name" box, and only when the profile has a preferred name, then waits for Workday to show the preferred name fields so the general pass can fill them. Keys a person may have no answer for (middle name, preferred name, address line 2, county, extension) are in `OPTIONAL_KEYS`: blank in the profile, their fields are skipped instead of outlined.

SAP SuccessFactors (`successfactors.ts`) has its own step too: it presses each section's "Add new row" until Work Experience and Education have a row per entry, and the general pass then fills row n from entry n. Its labels need two extra ideas. `normalizeLabel` in `keys.ts` drops asterisks, slashes and punctuation before the rules run, so "* Company / Organization" is "company organization", one of the employer synonyms. `sectionOf` in `engine.ts` reads the nearest section heading, so "Start Date" under Work Experience is the role's start, not the date you can start work. Its dates are SAP UI5 date picker web components. A content script can't see properties the page's code defines, so `setDatePicker` (`dom.ts`) writes the value attribute and types into the input inside the component's shadow root, with input, change and blur, which is what UI5 listens to. `dates.ts` turns a month and year into a day: the 1st for a start, the last day of the month for an end.

Every text value is set through the browser's own value setter, then `input`, `change` and blur, and read back (`setTextChecked`). A value the page dropped is set once more after a short wait; one that still doesn't match is reported as "didn't stick". Fields are filled one at a time with a short pause between them.

What it leaves alone is as important. Open questions ("Why do you want to work here?"), single checkboxes (consents), fields that already have an answer, and the submit and Next buttons are never touched. Every field it didn't fill is counted, outlined and summed up in "Filled 14 fields, 3 left for you" (`summary.ts`), with fields the page didn't accept counted on their own. On Workday each press fills the page that's showing.

The tests (Vitest with jsdom) load a saved form for each site, run the filler and check every field. The samples are rebuilt from each site's structure, since the real sites can't be reached from the build environment. The Workday tests add Workday's behaviour around the saved pages: dropdown buttons open their options, search boxes list matches after Enter, and each Add inserts a new entry from a `<template>` a moment later. They check the add-entry flow, the split dates, the skills, that entries Workday parsed aren't added twice, and that a second press changes nothing.

`workdayReal.test.ts` runs on the saved real Workday pages instead. `workdayEmulator.ts` stands in for Workday's scripts, built from what those pages show: a date commits only from key presses followed by blur, a search list adds a chip in the saved page's markup, a dropdown opens a listbox, Add clones an entry with fresh ids, and `validate` plays the Next button (required fields, committed dates, chosen items, full URLs). Each fix was checked by putting the old code back and seeing the tests fail, and the same fill was run in Chromium on the saved pages. The open option lists aren't in the saved pages (Workday draws them in a popup that was gone when the page was saved), so the list markup in the stand-in follows the listbox and option roles; that part is the one to watch on a real application.

## 9. Packaging

PyInstaller bundles Python, the app, the built interface and Tectonic into `Tailor.app` on a Mac and a folder on Windows. CI signs the Mac app ad hoc, wraps it in a `.dmg`, and builds a Windows installer with Inno Setup. Before uploading, it runs `Tailor --self-test`, which checks the bundled files and compiles a small document with the bundled Tectonic. It then opens the real window with a throwaway data folder, waits for the interface to report that it's talking to Python, makes one call through the bridge and closes.

## 10. How it's tested

- **Python, with pytest** (`tests/`): every truth check has its own tests, and the template engine is checked byte for byte. Providers run against a local stand-in for each API, using the real SDKs. The Claude Code and Codex providers run against fake `claude` and `codex` scripts that print what the real commands print. The bridge tests run whole runs with the Demo provider through to an exported one-page PDF.
- **The interface, with Vitest and Playwright** (`ui/`): unit tests for small pieces such as the preview fit, browser tests against an in-memory mock, and one test that opens the built page from `file://` against the real Python backend.
- **CI** runs the Python tests on Linux, macOS and Windows, the interface tests on Linux, and then builds and self-tests both installers.

## Questions you might get

**How do you stop the model from making things up?** The model can propose anything, but code checks every number, name and skill against the sources the rewrite cites, and blocks what it can't find. The check doesn't trust the model's citations either: a citation only counts if the cited text really contains the claim.

**Why not let the model edit the LaTeX?** Because then it could change fonts, margins or sections. The model only ever sees and writes plain text for one slot at a time, and that text is escaped before it goes into the file. A separate check compares the whole layout before and after every edit.

**Why one bridge method instead of exposing every function?** One entry point gives one list of allowed commands, one place to convert arguments and one place to turn exceptions into errors the interface understands. Nothing else on the object can be called from the page.

**What happens if two things change a run at the same time?** Changes go through a lock and always apply to the latest saved state, so neither one is lost.

**Why SQLite without an ORM?** The data is small, the queries are simple, and plain SQL is easy to read and explain. Migrations are a numbered list.

**Why is coverage counted in code and not by the model?** So the same resume and posting always give the same number, and so a skill you don't have can't raise it.
