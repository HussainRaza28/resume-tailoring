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

3. In Tailor's Settings, choose Claude Code. Settings shows whether `claude` was found, where, and whether it's signed in.

An app opened from the Start menu or Finder doesn't get your terminal's `PATH`, so Tailor also looks in `~/.local/bin` (`%USERPROFILE%\.local\bin` on Windows), npm's global folder and Homebrew's. If it still says Not installed, press **Choose path…** next to the status and pick the `claude` command. The same goes for `codex`.

Tailor removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` when it starts `claude`, so a key in your environment can't switch it to API billing. This provider is meant for personal use with your own subscription.

## The ChatGPT (Codex) provider

"ChatGPT (Codex)" runs each step through OpenAI's `codex` command on your computer, so it uses your ChatGPT plan instead of API credits. To use it:

1. Install Codex (it needs Node.js):

```bash
npm install -g @openai/codex
```

2. Sign in once in a terminal, choosing "Sign in with ChatGPT":

```bash
codex login
```

3. In Tailor's Settings, choose ChatGPT (Codex). Settings shows whether `codex` was found and whether it's signed in with ChatGPT. Leave the model empty to use Codex's default, or type one your plan offers.

Tailor removes `OPENAI_API_KEY` and `CODEX_API_KEY` when it starts `codex`, so a key in your environment can't switch it to API billing. If Codex itself was signed in with an API key, Settings says so. Codex runs read-only in an empty folder, so it can't change files on your computer. Like the Claude Code provider, this is meant for personal use with your own plan.

## Using it

1. **Paste a posting** and press Tailor (Cmd+Enter on a Mac, Ctrl+Enter on Windows). The company is filled in for you, and you can change it.
2. **Score.** Your base resume's ATS score out of 100 and the top three red flags. Add anything the resume is missing in "Anything to add?" (it's saved to your facts bank, and Undo takes it out again), then press Rewrite.
3. **Rewrite.** Only the bullets a red flag or missing keyword calls for, old and new side by side. Accept with → or keep the original with ←. A rewrite that invents a number, name or skill is blocked and says why. Style findings, or a tool or number the rewrite dropped, show as a warning and you can still accept it.
4. **Done.** The score before and after, scored together so the difference is your changes, keyword coverage, and Export PDF. The PDF is named after you and the company, such as `Jordan_Sample_Resume_Larkspur_Freight.pdf`. A result longer than one page isn't exported; Tailor suggests which bullets to trim instead.

Every step shows the company, the role and a link back to the posting.

**Jobs** lists open internships from the [Simplify](https://github.com/SimplifyJobs/Summer2027-Internships), [vanshb03](https://github.com/vanshb03/Summer2027-Internships) and [SpeedyApply](https://github.com/speedyapply/2027-SWE-College-Jobs) lists on GitHub, newest first, with a posting that's on more than one list shown once. Search, or filter by company, role, location and date posted. Typing "United States" (or US, USA) in Location matches every US listing, whatever city it names. Roles only open to Master's or PhD students are hidden unless you tick "Show PhD and Master's roles". Each role links to its posting. Listings that appeared since your last visit say New. The list refreshes when you open it if it's more than an hour old, and the last copy is kept so it works offline. "Tailor" reads the posting from its link and starts a run; when a site (Workday, for example) won't show the posting to the app, you get the company and role filled in and a button to open the posting so you can paste it. "Mark applied" adds it to your applications with the link.

The preview on the right updates as you decide. Cmd+K or Ctrl+K opens the command bar to search history and switch screens. The sidebar has your history, an application tracker and the facts bank. In the facts bank you can drop a PDF, Word, text or Markdown file, or paste a link to your site, and Tailor suggests facts from it; nothing is saved until you accept it.

## Tailor Autofill (Chrome extension)

Tailor Autofill fills job applications on Workday, Greenhouse, Lever, Ashby and SAP SuccessFactors from a profile you keep in Chrome, and matches fields by their labels on other sites. It lives in `extension/`.

**Install it with Load unpacked.** Either download the built extension from the latest CI run (the `Tailor-Autofill-extension` artifact) and unzip it, or build it yourself:

```bash
cd extension
```

```bash
npm ci
```

```bash
npm run build
```

Then, in Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder, or `extension/dist` if you built it.
4. Pin Tailor Autofill from the puzzle-piece menu so its button stays in the toolbar.

After an update, build again (or unzip the new artifact over the old folder) and click the reload arrow on the extension's card in `chrome://extensions`.

**Set up your profile once.** Click the toolbar button, then Edit profile. Fill in your details, choose your resume PDF, and save. The top of the page follows Workday's My Information page:

- **Legal name:** first, middle and last. Under it, **Preferred name**: tick "I have a preferred name" to show the preferred first and last name fields.
- **Contact:** email, phone device type (Mobile by default), country phone code, phone number and extension.
- **Address:** country, address lines 1 and 2, city, state, postal code and county.

Below that are your roles (title, company, location, dates and bullets), schools (with "I'm currently enrolled here", which makes the end date your expected graduation), skills, languages and links. Then:

- **Work authorization:** authorized to work in the country, sponsorship needed now, sponsorship needed in the future, U.S. citizen, and security clearance (None by default).
- **Common questions:** how you heard about the job (Job board), previously worked for this company (No), 18 or older (Yes), willing to relocate, and the dates you're available from and until.

The demographic questions all default to "Decline to answer". A profile saved by an older version keeps its answers: its one sponsorship answer fills both "now" and "in the future", and a start date such as "May 2027" becomes May 1, 2027.

**Or import it from Tailor.** In the app, open Settings and press **Export for Autofill** under Base resume. It saves a `.json` profile built from your base resume: contact links, every role and school with dates and bullets, your skills, and your facts bank. In the extension's profile page press **Import from Tailor**, pick that file, check the list of changes, and press Apply. Your address, answers and self-identification stay as they were, and everything stays editable.

**Fill an application.** On Workday, Greenhouse, Lever, Ashby and SuccessFactors an Autofill button appears in the bottom corner of the page. On any other site, use Autofill this page in the toolbar popup. Each press fills the page that's showing; on Workday, press it again on each page after Save and Continue:

- **My Information:** legal name with middle name, address with line 2 and county, email, phone with its type, country code and extension, how you heard, and whether you've worked there before. "I have a preferred name" is ticked, and the preferred name filled, only when your profile has a preferred name; otherwise the box is left as it is. Fields you have no answer for, such as a middle name or a second address line, are skipped rather than outlined.
- **My Experience:** presses Add for each role, school, language and website and fills every field, with a role's bullets as its description, one per line. If Workday already read your resume into entries, it fills their blanks instead of adding copies. Skills are picked one by one from the skills list, and the resume and LinkedIn are added too.
- **Application Questions:** work authorization, sponsorship (a question about now, the future, or both gets the matching answer), 18 or older, worked here before, U.S. citizen, security clearance, willing to relocate, currently enrolled, and your start date, including Workday's separate month, day and year boxes. Open questions are outlined for you.
- **Voluntary Disclosures and Self Identify:** your answers, "Decline to answer" by default, plus your name and today's date on the disability form.

On Greenhouse, each employment block and the education dates are filled from the same roles and schools.

On SuccessFactors career sites (such as `<company>.jobs.hr.cloud.sap`), Autofill first presses "Add new row" in Work Experience and Education until there's a row for each role and school, then fills row by row: title, company, school, degree, and the start and end dates. Those date fields want a day, and your profile keeps a month and year, so a start date becomes the 1st of its month and an end date the last day of its month (February 29 in a leap year). A date with a day keeps it, and a current role's end date stays blank. Dates are written the way the field asks, such as MM/DD/YYYY.

Autofill:

- never submits, and never presses Next, Save and Continue or Review; on Workday the only button it presses is Add
- leaves open questions such as "Why do you want to work here?" blank
- never ticks a consent or terms box, and never changes a field you've already filled
- reads every value back after setting it, sets it once more if the page dropped it, and pauses briefly between fields so a page that redraws itself keeps what was filled
- shows "Filled 14 fields, 3 left for you" and outlines what's left until you answer it. Details in that box lists each field by its label under Filled, Skipped (nothing to put there, such as a current role's end date), Didn't stick (the page wouldn't keep the value) and Left for you. The same list is in the browser console as "Tailor Autofill: …".

Your profile and resume stay in Chrome's storage on your computer. The extension makes no network calls and has no tracking. It only runs in a page when you're on one of the job sites above or press Autofill in the popup.

## Privacy

- Your resume, postings, outputs, facts bank and history stay in a private folder on your computer. You can see where it is, or move it, in Settings under Data.
- A run sends your resume and the posting to the provider you chose, and only that provider. Ollama and the offline demo send nothing anywhere.
- API keys live in the system keychain.
- The Jobs screen downloads the three public listing files from GitHub. Nothing about you is sent.
- The app has no account, no analytics and no server of its own. The Autofill extension sends nothing anywhere either.

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
