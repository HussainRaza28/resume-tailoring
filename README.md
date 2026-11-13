# Tailor

A desktop app that tailors a LaTeX resume to a job posting. It flags problems, suggests rewrites that are checked against what the resume already says, scores the result, and exports a one-page PDF in the original template.

This is a work in progress. The full README, with install steps, comes with the first release.

## Installing from a build

CI builds an installer for Apple Silicon Macs (`.dmg`) and for Windows (`Tailor-Setup.exe`); download it from the run's artifacts.

On a Mac, open the `.dmg` and drag Tailor to Applications. The app is signed ad hoc, not with a paid developer certificate, so the first time, right-click it and choose Open. If macOS still says the app is damaged, clear the download flag and try again:

```bash
xattr -cr /Applications/Tailor.app
```

## Development

You need [uv](https://docs.astral.sh/uv/).

```bash
uv sync
```

```bash
uv run python scripts/fetch_tectonic.py
```

```bash
uv run pytest
```

The tests that compile a PDF are skipped if Tectonic hasn't been downloaded.

The interface lives in `ui/` and needs Node 22. Build it once, then open the app:

```bash
cd ui && npm ci && npm run build
```

```bash
uv run python -m app.main
```

Set `TAILOR_DATA_DIR=data/private` to keep your data in the repo's ignored `data/private/` folder while developing. In `ui/`, `npm test` runs the unit tests and `npm run e2e` the browser tests.

Why things are built the way they are is in [docs/DECISIONS.md](docs/DECISIONS.md).
