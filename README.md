# Tailor

A desktop app for Mac and Windows that tailors a LaTeX resume to a job posting. Find an internship, tailor your resume to it, apply. Tailor scores your resume against the posting, rewrites the bullets that need it, and exports a one-page PDF in your own template.

It doesn't invent anything. Every number, name and skill in a rewrite is checked in code against your resume and your facts bank, and a rewrite that adds something it can't back up is blocked, with the reason shown. Only the text of your bullets, headings and skills lines ever changes. Fonts, margins and sections stay exactly as you wrote them.

## Install

CI builds an installer for Apple Silicon Macs (`.dmg`) and one for Windows (`Tailor-Setup-<version>.exe`). Download them from the artifacts of a CI run on GitHub.

**Mac.** Open the `.dmg` and drag Tailor to Applications. The app is signed ad hoc rather than with a paid Apple developer certificate, so macOS blocks the first open. Go to System Settings, then Privacy & Security, and choose Open Anyway next to Tailor. If macOS says instead that the app is damaged, remove the download flag and open it again:

```bash
xattr -cr /Applications/Tailor.app
```

**Windows.** Run the installer. It installs for your user account, so it doesn't need an administrator. Tailor uses the WebView2 runtime that comes with Windows 10 and 11.

The first PDF you compile takes a little longer: the bundled TeX engine, Tectonic, downloads the LaTeX packages it needs once and keeps them.

## First run

1. **Choose your base resume.** Pick your `.tex` file when Tailor asks, or later in Settings. Tailor copies it into its private data folder and never edits the original. The template should follow Jake's Resume (`\resumeItem`, `\resumeSubheading`, `\resumeProjectHeading` and a Technical Skills section).
2. **Pick a provider** in Settings, or from the menu at the top right.

| Provider | What you need | Cost |
| --- | --- | --- |
| Claude Code (Pro plan) | Claude Code installed and signed in on this computer | Counts toward your Claude plan |
| Claude API | An Anthropic API key | Per token; shown at the bottom of each run |
| Gemini | A Gemini API key | Free tier |
| Ollama | Ollama running with a model pulled | Free, and nothing leaves your computer |
| Offline demo | Nothing | Free; placeholder output for trying the app |

## API keys

Add keys in Settings under API keys. They're stored in the macOS Keychain or the Windows Credential Manager, never in a file, and the app only ever shows the first and last few characters. You can get an Anthropic key from the Claude Console and a Gemini key from Google AI Studio.

## The Claude Code provider

"Claude Code (Pro plan)" runs each step through the `claude` command on your computer, so it uses your Claude subscription instead of API credits. To use it:

1. Install Claude Code.
2. Sign in once in a terminal:

```bash
claude auth login
```

3. In Tailor's Settings, choose Claude Code. Settings shows whether `claude` was found and whether it's signed in.

Tailor removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` when it starts `claude`, so a key in your environment can't switch it to API billing. This provider is meant for personal use with your own subscription.

## Using it

1. **Paste a posting** and press Tailor (Cmd+Enter on a Mac, Ctrl+Enter on Windows). The company is filled in for you, and you can change it.
2. **Score.** Your base resume's ATS score out of 100 and the top three red flags. Add anything the resume is missing in "Anything to add?" (it's saved to your facts bank, and Undo takes it out again), then press Rewrite.
3. **Rewrite.** Only the bullets a red flag or missing keyword calls for, old and new side by side. Accept with → or keep the original with ←. A rewrite that invents something, or drops a tool or number your bullet had, is blocked and says why.
4. **Done.** The score before and after, scored together so the difference is your changes, keyword coverage, and Export PDF. The PDF is named after you and the company, such as `Jordan_Sample_Resume_Larkspur_Freight.pdf`. A result longer than one page isn't exported; Tailor suggests which bullets to trim instead.

Every step shows the company, the role and a link back to the posting.

**Jobs** lists open internships from the [Simplify](https://github.com/SimplifyJobs/Summer2027-Internships) and [SpeedyApply](https://github.com/speedyapply/2027-SWE-College-Jobs) lists on GitHub, newest first. Search, or filter by company, role, location and date posted. Listings that appeared since your last visit say New. The list refreshes when you open it if it's more than an hour old, and the last copy is kept so it works offline. "Tailor for this" reads the posting from its link and starts a run; when a site (Workday, for example) won't show the posting to the app, you get the company and role filled in and a button to open the posting so you can paste it. "Mark applied" adds it to your applications with the link.

The preview on the right updates as you decide. Cmd+K or Ctrl+K opens the command bar to search history and switch screens. The sidebar has your history, an application tracker and the facts bank. In the facts bank you can drop a PDF, Word, text or Markdown file, or paste a link to your site, and Tailor suggests facts from it; nothing is saved until you accept it.

## Privacy

- Your resume, postings, outputs, facts bank and history stay in a private folder on your computer. You can see where it is, or move it, in Settings under Data.
- A run sends your resume and the posting to the provider you chose, and only that provider. Ollama and the offline demo send nothing anywhere.
- API keys live in the system keychain.
- The Jobs screen downloads the two public listing files from GitHub. Nothing about you is sent.
- The app has no account, no analytics and no server of its own.

## Development

You need [uv](https://docs.astral.sh/uv/) and Node 22.

```bash
uv sync
```

```bash
uv run python scripts/fetch_tectonic.py
```

```bash
uv run pytest
```

Tests that compile a PDF are skipped if Tectonic hasn't been downloaded. To run the app from source, build the interface, then start the window:

```bash
cd ui && npm ci && npm run build
```

```bash
uv run python -m app.main
```

Set `TAILOR_DATA_DIR=data/private` to keep your data in the repository's ignored `data/private/` folder while developing. In `ui/`, `npm test` runs the unit tests and `npm run e2e` runs the browser tests. To build the app itself, see `packaging/tailor.spec`.

- [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) is a tour of the backend, part by part.
- [docs/DECISIONS.md](docs/DECISIONS.md) records why things are built the way they are.
