"""Internship listings from three GitHub repos, for the Jobs screen.

The sources are fixed: SimplifyJobs/Summer2027-Internships,
vanshb03/Summer2027-Internships and speedyapply/2027-SWE-College-Jobs.
Simplify and vanshb03 publish their listings as a JSON file in the repo (the
same format), which is read first. speedyapply publishes only Markdown tables
in its README files, so those are parsed. If a JSON file can't be read, that
repo's README table is parsed the same way. Only internship lists are read.

Closed listings are dropped. A posting that appears in more than one repo is
shown once, with every source. Each listing says whether it is in the US and
whether it needs a Master's or PhD. The last good fetch is kept in the data
folder, so the list still opens offline.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx2
from bs4 import BeautifulSoup
from pydantic import BaseModel

from app.importers import places

# The JSON file is about 13 MB, larger than anything the facts import reads.
MAX_BYTES = 40 * 1024 * 1024
TIMEOUT = httpx2.Timeout(30.0, connect=10.0)
HEADERS = {"user-agent": "Tailor/0.1 (resume tailoring app)"}
RAW = "https://raw.githubusercontent.com"


@dataclass(frozen=True)
class JobSource:
    id: str
    name: str
    repo: str
    # A structured listings file, preferred when there is one.
    data_url: str | None
    # README files with listing tables: the fallback, or the only source.
    readme_urls: tuple[str, ...]


SIMPLIFY = JobSource(
    id="simplify",
    name="Simplify",
    repo="SimplifyJobs/Summer2027-Internships",
    data_url=f"{RAW}/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
    readme_urls=(f"{RAW}/SimplifyJobs/Summer2027-Internships/dev/README.md",),
)
SPEEDYAPPLY = JobSource(
    id="speedyapply",
    name="SpeedyApply",
    repo="speedyapply/2027-SWE-College-Jobs",
    data_url=None,
    # README.md lists US internships and INTERN_INTL.md the rest. The new grad files are left out.
    readme_urls=(
        f"{RAW}/speedyapply/2027-SWE-College-Jobs/main/README.md",
        f"{RAW}/speedyapply/2027-SWE-College-Jobs/main/INTERN_INTL.md",
    ),
)
VANSH = JobSource(
    id="vanshb03",
    name="vanshb03",
    repo="vanshb03/Summer2027-Internships",
    data_url=f"{RAW}/vanshb03/Summer2027-Internships/dev/.github/scripts/listings.json",
    readme_urls=(f"{RAW}/vanshb03/Summer2027-Internships/dev/README.md",),
)
SOURCES = (SIMPLIFY, VANSH, SPEEDYAPPLY)


class Listing(BaseModel):
    id: str
    company: str
    role: str
    locations: list[str]
    # YYYY-MM-DD. README tables only give an age such as "3d", so it's counted
    # back from the day of the fetch.
    date_posted: str
    url: str
    sources: list[str]
    # When this app first saw it, for the "New" badge.
    first_seen_at: str = ""
    # Only open to Master's or PhD students: hidden unless the user asks to see them.
    advanced_degree: bool = False
    # At least one of its locations is in the US (see places.py).
    us: bool = False


class JobsError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


def fetch_text(url: str) -> str:
    try:
        resp = httpx2.get(url, headers=HEADERS, timeout=TIMEOUT, follow_redirects=True)
    except httpx2.TransportError as e:
        raise JobsError("offline", f"Could not reach {urlparse(url).netloc}.") from e
    if resp.status_code >= 400:
        raise JobsError("http", f"{urlparse(url).path.rsplit('/', 1)[-1]} answered with HTTP {resp.status_code}.")
    if len(resp.content) > MAX_BYTES:
        raise JobsError("too_big", "The listings file is too large to read.")
    return resp.text


def fetch_source(source: JobSource, today: date) -> list[Listing]:
    """One source's open listings: from its data file if it has one, otherwise its README tables."""
    if source.data_url:
        try:
            return parse_listings_json(json.loads(fetch_text(source.data_url)), source.name)
        except (JobsError, ValueError, KeyError, TypeError):
            pass  # fall back to the README below
    listings: list[Listing] = []
    for url in source.readme_urls:
        listings += parse_readme(fetch_text(url), source.name, today)
    return listings


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

_TRACKING = {"ref", "source", "gh_src"}


def canonical_url(url: str) -> str:
    """The posting's address without tracking parameters, for spotting the same job in both repos."""
    parts = urlparse(url.strip())
    query = [(k, v) for k, v in parse_qsl(parts.query) if not k.lower().startswith("utm_") and k.lower() not in _TRACKING]
    path = parts.path.rstrip("/")
    return urlunparse((parts.scheme.lower(), parts.netloc.lower(), path, "", urlencode(query), ""))


# "PhD", "Ph.D.", "Master's", "Masters", "MBA" or "doctoral" in a title.
_ADVANCED_TITLE = re.compile(r"\b(ph\.?\s?d\.?|master'?s|mba|doctoral)\b", re.IGNORECASE)
_BACHELORS = {"Bachelor's", "Associate's"}


def needs_advanced_degree(title: str, degrees: list[str] | None = None, marked: bool = False) -> bool:
    """True for a role open only to Master's or PhD students.

    Each list marks it its own way: Simplify's JSON lists the degrees a role
    accepts, and its README puts 🎓 on the role. A list with no marker, or a
    role with no degrees given, falls back to the title. A role that also
    accepts a Bachelor's isn't advanced, whatever its title says.
    """
    if degrees:
        return not (_BACHELORS & set(degrees))
    return marked or bool(_ADVANCED_TITLE.search(title))


def _listing(
    company: str, role: str, locations: list[str], posted: date, url: str, source: str, advanced: bool = False
) -> Listing | None:
    company, role, url = " ".join(company.split()), " ".join(role.split()), url.strip()
    if not company or not role or not url.startswith(("http://", "https://")):
        return None
    places_ = [" ".join(loc.split()) for loc in locations if loc.strip()]
    return Listing(
        id=canonical_url(url),
        company=company,
        role=role,
        locations=places_,
        date_posted=posted.isoformat(),
        url=url,
        sources=[source],
        advanced_degree=advanced,
        us=any(places.is_us(loc) for loc in places_),
    )


def parse_listings_json(data: list[dict], source: str) -> list[Listing]:
    """A listings.json in Simplify's format (Simplify and vanshb03): every listing ever posted, with ``active``."""
    out = []
    for item in data:
        if not item.get("active") or not item.get("is_visible", True):
            continue
        posted = datetime.fromtimestamp(int(item["date_posted"]), tz=UTC).date()
        advanced = needs_advanced_degree(item["title"], item.get("degrees"))
        listing = _listing(
            item["company_name"], item["title"], item.get("locations") or [], posted, item["url"], source, advanced
        )
        if listing:
            out.append(listing)
    return out


_AGE = re.compile(r"^(\d+)\s*(d|mo)$")


def age_to_date(age: str, today: date) -> date | None:
    """ "3d" is three days before ``today``; "2mo" is about two months (30 days each)."""
    m = _AGE.match(age.strip())
    if not m:
        return None
    n = int(m.group(1))
    return today - timedelta(days=n * (30 if m.group(2) == "mo" else 1))


def _locations(cell) -> list[str]:
    """A location cell: one place, places split by <br>, or a <details> list with a summary."""
    details = cell.find("details")
    if details is not None:
        summary = details.find("summary")
        if summary is not None:
            summary.decompose()
        cell = details
    for br in cell.find_all("br"):
        br.replace_with("\n")
    return [part.strip() for part in cell.get_text().split("\n") if part.strip()]


def _cells_from_markdown_row(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def parse_readme(text: str, source: str, today: date) -> list[Listing]:
    """Listing tables in a README: Markdown pipe tables (speedyapply) or HTML tables (Simplify).

    Columns are found by their header names, so a table with or without a
    Salary column reads the same. A row marked closed (🔒) is skipped, and a
    company cell of "↳" repeats the company above it.
    """
    out: list[Listing] = []
    columns: dict[str, int] | None = None
    for line in text.splitlines():
        if line.startswith("| Company"):
            names = [c.lower() for c in _cells_from_markdown_row(line)]
            columns = {name: i for i, name in enumerate(names)}
            continue
        if not line.startswith("|"):
            columns = None  # the table has ended
            continue
        if columns is None or line.startswith("|-"):
            continue
        cells = [BeautifulSoup(c, "html.parser") for c in _cells_from_markdown_row(line)]
        listing = _row(cells, columns, source, today, previous=out[-1].company if out else "")
        if listing:
            out.append(listing)

    soup = BeautifulSoup(text, "html.parser") if "<table" in text else None
    for table in soup.find_all("table") if soup else []:
        head = [th.get_text(" ", strip=True).lower() for th in table.find_all("th")]
        if "company" not in head:
            continue
        columns = {name: i for i, name in enumerate(head)}
        previous = ""
        for tr in table.find_all("tr"):
            cells = tr.find_all("td")
            if not cells:
                continue
            listing = _row(cells, columns, source, today, previous)
            if listing:
                previous = listing.company
                out.append(listing)
    return out


def _row(cells: list, columns: dict[str, int], source: str, today: date, previous: str) -> Listing | None:
    def cell(name: str):
        i = columns.get(name)
        return cells[i] if i is not None and i < len(cells) else None

    company_cell, role_cell = cell("company"), cell("role") or cell("position")
    link_cell = cell("application") or cell("posting") or cell("application/link")
    location_cell = cell("location")
    if company_cell is None or role_cell is None or link_cell is None:
        return None
    if "🔒" in link_cell.get_text() or "🔒" in role_cell.get_text():
        return None
    company = company_cell.get_text(" ", strip=True).replace("🔥", "").strip()
    if company == "↳":
        company = previous
    link = link_cell.find("a")
    # An age ("3d") in Simplify and SpeedyApply, a date ("Nov 14") in vanshb03.
    age_cell, date_cell = cell("age"), cell("date posted")
    if age_cell is not None:
        posted = age_to_date(age_cell.get_text(strip=True), today)
    else:
        posted = month_day_to_date(date_cell.get_text(strip=True), today) if date_cell is not None else None
    if link is None or posted is None:
        return None
    locations = _locations(location_cell) if location_cell is not None else []
    raw_role = role_cell.get_text(" ", strip=True)
    role = raw_role.replace("🎓", "").replace("🛂", "").replace("🇺🇸", "").strip()
    advanced = needs_advanced_degree(role, marked="🎓" in raw_role)
    return _listing(company, role, locations, posted, link.get("href", ""), source, advanced)


def month_day_to_date(text: str, today: date) -> date | None:
    """ "Nov 14" is the latest Nov 14 that isn't after ``today``."""
    try:
        day = datetime.strptime(f"{text.strip()} {today.year}", "%b %d %Y").replace(tzinfo=UTC).date()
    except ValueError:
        return None
    return day if day <= today else day.replace(year=today.year - 1)


def _squash(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _same_job_key(listing: Listing) -> tuple[str, str]:
    """Company and title with case, punctuation and spacing ignored."""
    return _squash(listing.company), _squash(listing.role)


def _same_place(a: Listing, b: Listing) -> bool:
    """Locations that overlap, or one side that doesn't say."""
    if not a.locations or not b.locations:
        return True
    return bool({x.lower() for x in a.locations} & {x.lower() for x in b.locations})


def _absorb(into: Listing, other: Listing) -> None:
    for s in other.sources:
        if s not in into.sources:
            into.sources.append(s)
    # The earlier date is when it was really posted.
    into.date_posted = min(into.date_posted, other.date_posted)
    into.advanced_degree = into.advanced_degree or other.advanced_degree
    into.us = into.us or other.us


def merge(groups: list[list[Listing]]) -> list[Listing]:
    """One entry per posting across all sources, newest first.

    The same address is the same posting. Across different sources, the same
    company and title in an overlapping place is too: vanshb03 links through
    its own short links, so its addresses never match the other lists'.
    """
    by_id: dict[str, Listing] = {}
    by_job: dict[tuple[str, str], list[Listing]] = {}
    for listings in groups:
        for listing in listings:
            seen = by_id.get(listing.id)
            if seen is None:
                key = _same_job_key(listing)
                seen = next(
                    (
                        x
                        for x in by_job.get(key, [])
                        if not set(x.sources) & set(listing.sources) and _same_place(x, listing)
                    ),
                    None,
                )
            if seen is None:
                kept = listing.model_copy(deep=True)
                by_id[listing.id] = kept
                by_job.setdefault(_same_job_key(listing), []).append(kept)
            else:
                _absorb(seen, listing)
    return sorted(by_id.values(), key=lambda x: (x.date_posted, x.company.lower()), reverse=True)


# ---------------------------------------------------------------------------
# The cache and the "New" badge
# ---------------------------------------------------------------------------


class JobsState(BaseModel):
    fetched_at: str | None = None
    listings: list[Listing] = []
    # Sources whose last refresh failed, with the reason. Their listings are
    # the ones from the last good fetch.
    errors: dict[str, str] = {}
    # The visit before this one, and this one. A listing first seen after the
    # previous visit gets the "New" badge.
    last_visit_at: str | None = None
    visit_at: str | None = None


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class JobsCache:
    """The last fetch and visit times, kept as JSON in the private data folder."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load(self) -> JobsState:
        try:
            return JobsState.model_validate_json(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return JobsState()

    def save(self, state: JobsState) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(state.model_dump_json(), encoding="utf-8")
        tmp.replace(self.path)

    def start_visit(self) -> JobsState:
        """Opening the Jobs screen: this visit becomes the one listings are compared with next time."""
        state = self.load()
        state.last_visit_at = state.visit_at
        state.visit_at = now_iso()
        self.save(state)
        return state

    def refresh(self, fetch=fetch_source, today: date | None = None) -> JobsState:
        """Fetch both sources. A source that fails keeps its listings from the last good fetch."""
        state = self.load()
        today = today or datetime.now(UTC).date()
        stamp = now_iso()
        first_seen = {x.id: x.first_seen_at for x in state.listings}
        groups: list[list[Listing]] = []
        errors: dict[str, str] = {}
        for source in SOURCES:
            try:
                groups.append(fetch(source, today))
            except JobsError as e:
                errors[source.name] = e.message
                groups.append([x for x in state.listings if source.name in x.sources])
        if len(errors) == len(SOURCES):
            # Nothing came back: keep everything as it was and say why.
            state.errors = errors
            self.save(state)
            return state
        listings = merge(groups)
        for x in listings:
            x.first_seen_at = first_seen.get(x.id) or stamp
        state.listings = listings
        state.errors = errors
        state.fetched_at = stamp
        self.save(state)
        return state


def is_new(listing: Listing, state: JobsState) -> bool:
    """Seen for the first time since the previous visit. Nothing is new on the very first visit."""
    return bool(state.last_visit_at) and listing.first_seen_at > state.last_visit_at
