# Tailor

A desktop app that tailors a LaTeX resume to a job posting. It flags problems, suggests rewrites that are checked against what the resume already says, scores the result, and exports a one-page PDF in the original template.

This is a work in progress. The full README, with install steps, comes with the first release.

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

Why things are built the way they are is in [docs/DECISIONS.md](docs/DECISIONS.md).
