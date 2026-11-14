"""Tests for the Jobs listings: parsing the three repos from saved samples, the cache and the "New" badge.

No test touches the network. The samples in tests/fixtures/jobs are short cuts of
the real files from SimplifyJobs/Summer2027-Internships,
vanshb03/Summer2027-Internships and speedyapply/2027-SWE-College-Jobs.
"""

import json
from datetime import date
from pathlib import Path

import pytest

from app.bridge import Backend, Bridge
from app.core.db import Db
from app.core.secrets import MemoryStore
from app.importers import jobs
from app.importers.jobs import (
    SIMPLIFY,
    SPEEDYAPPLY,
    VANSH,
    JobsCache,
    JobsError,
    age_to_date,
    canonical_url,
    fetch_source,
    is_new,
    merge,
    month_day_to_date,
    needs_advanced_degree,
    parse_listings_json,
    parse_readme,
)

FIXTURES = Path(__file__).parent / "fixtures" / "jobs"
TODAY = date(2026, 11, 14)


def sample(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


SIMPLIFY_JSON = json.loads(sample("simplify_listings.json"))
VANSH_JSON = json.loads(sample("vanshb03_listings.json"))
FILES = {
    SIMPLIFY.data_url: sample("simplify_listings.json"),
    SIMPLIFY.readme_urls[0]: sample("simplify_README.md"),
    VANSH.data_url: sample("vanshb03_listings.json"),
    VANSH.readme_urls[0]: sample("vanshb03_README.md"),
    SPEEDYAPPLY.readme_urls[0]: sample("speedyapply_README.md"),
    SPEEDYAPPLY.readme_urls[1]: sample("speedyapply_INTERN_INTL.md"),
}


@pytest.fixture
def saved_files(monkeypatch):
    """fetch_text answers from the saved samples. Tests can delete entries to make a fetch fail."""
    files = dict(FILES)

    def fake_fetch(url):
        if url not in files:
            raise JobsError("http", "answered with HTTP 404.")
        return files[url]

    monkeypatch.setattr(jobs, "fetch_text", fake_fetch)
    return files


# -- Simplify's listings.json -------------------------------------------------


def test_simplify_json_keeps_only_open_visible_listings():
    listings = parse_listings_json(SIMPLIFY_JSON, "Simplify")
    open_ones = [x for x in SIMPLIFY_JSON if x["active"] and x["is_visible"]]
    assert len(listings) == len(open_ones) == 8
    assert {x.company for x in listings} == {x["company_name"] for x in open_ones}
    first = listings[0]
    assert first.role == open_ones[0]["title"]
    assert first.locations == open_ones[0]["locations"]
    assert first.sources == ["Simplify"]
    assert len(first.date_posted) == 10 and first.date_posted.startswith("20")


# -- vanshb03 -------------------------------------------------------------------


def test_vanshb03_json_has_the_same_format_and_its_phd_roles_are_flagged_by_title():
    listings = parse_listings_json(VANSH_JSON, "vanshb03")
    assert len(listings) == 4, "the closed one is dropped"
    phd = next(x for x in listings if "PhD" in x.role)
    assert phd.advanced_degree
    assert sum(x.advanced_degree for x in listings) == 1
    assert all(x.url.startswith("https://go.vansh.nyc/") for x in listings)


def test_vanshb03_readme_dates_and_closed_rows():
    listings = parse_readme(sample("vanshb03_README.md"), "vanshb03", TODAY)
    assert len(listings) == 3, "the closed (🔒) row is dropped"
    assert all(x.date_posted <= TODAY.isoformat() for x in listings)
    assert listings[0].company == "Ericsson" and listings[0].locations == ["Plano, TX"] and listings[0].us
    assert "🛂" not in listings[0].role


def test_month_day_dates_never_land_in_the_future():
    assert month_day_to_date("Nov 14", TODAY) == date(2026, 11, 14)
    assert month_day_to_date("Dec 30", TODAY) == date(2025, 12, 30)
    assert month_day_to_date("soon", TODAY) is None


def test_the_same_job_in_two_lists_is_merged_by_company_and_title():
    simplify = parse_listings_json(SIMPLIFY_JSON, "Simplify")
    vansh = parse_listings_json(VANSH_JSON, "vanshb03")
    merged = merge([simplify, vansh])
    tmg = [x for x in merged if x.company == "TransMarket Group"]
    assert len(tmg) == 1 and tmg[0].sources == ["Simplify", "vanshb03"]
    assert not tmg[0].url.startswith("https://go.vansh.nyc"), "the first list's direct link is kept"
    assert len(merged) == len(simplify) + len(vansh) - 1


def test_within_one_list_same_title_elsewhere_is_a_different_job():
    a = parse_listings_json(SIMPLIFY_JSON[:1], "Simplify")[0]
    other_city = a.model_copy(update={"id": "https://jobs.example.com/2", "url": "https://jobs.example.com/2", "locations": ["Reading, UK"]})
    assert len(merge([[a, other_city]])) == 2
    elsewhere = other_city.model_copy(update={"sources": ["vanshb03"]})
    assert len(merge([[a], [elsewhere]])) == 2, "different places, so not the same posting"


# -- degrees ----------------------------------------------------------------------


def test_advanced_degree_rules():
    # Simplify's JSON lists the degrees a role accepts.
    assert needs_advanced_degree("Intern - Physics & AI modeling Engineering", ["Master's", "PhD"])
    assert not needs_advanced_degree("Quantitative Researcher Intern", ["Bachelor's", "Master's", "PhD"])
    assert not needs_advanced_degree("PhD Research Intern", ["Bachelor's", "PhD"]), "it also takes a Bachelor's"
    # Without degrees, the README marker or the title decides.
    assert needs_advanced_degree("Software Engineer Intern", marked=True)
    for title in ("Machine Learning Intern, PhD", "Ph.D. Research Intern", "Master's Intern - Data", "MBA Intern",
                  "Doctoral Researcher Intern"):
        assert needs_advanced_degree(title), title
    for title in ("Software Engineer Intern", "Mastercard Data Intern", "Photonics Intern"):
        assert not needs_advanced_degree(title), title


def test_simplify_flags_master_and_phd_only_roles_from_its_degrees():
    listings = parse_listings_json(SIMPLIFY_JSON, "Simplify")
    flagged = [x.role for x in listings if x.advanced_degree]
    assert flagged == ["Intern - Physics & AI modeling Engineering"]


def test_simplify_readme_marks_advanced_roles_with_a_cap():
    first_role = parse_readme(sample("simplify_README.md"), "Simplify", TODAY)[0].role
    html = sample("simplify_README.md").replace(f"<td>{first_role}</td>", f"<td>{first_role} 🎓</td>", 1)
    listings = parse_readme(html, "Simplify", TODAY)
    assert listings[0].advanced_degree and "🎓" not in listings[0].role
    assert not any(x.advanced_degree for x in listings[1:])


def test_every_listing_says_whether_it_is_in_the_us():
    listings = parse_readme(sample("speedyapply_README.md"), "SpeedyApply", TODAY)
    assert all(x.us for x in listings), [x.locations for x in listings if not x.us]
    intl = parse_readme(sample("speedyapply_INTERN_INTL.md"), "SpeedyApply", TODAY)
    assert not any(x.us for x in intl), [x.locations for x in intl if x.us]


# -- README tables ------------------------------------------------------------


def test_speedyapply_tables_with_and_without_a_salary_column():
    listings = parse_readme(sample("speedyapply_README.md"), "SpeedyApply", TODAY)
    assert len(listings) == 6
    meta = listings[0]
    assert (meta.company, meta.locations) == ("Meta", ["Burlingame, CA"])
    assert meta.role.startswith("Research Intern")
    assert meta.url == "https://www.metacareers.com/jobs/1560905132724186"
    assert meta.date_posted == "2026-11-11", "3d before the fetch"
    # The "Other" table has no Salary column, so its columns sit one place over.
    muon = next(x for x in listings if x.company == "Muon")
    assert muon.locations == ["San Jose, CA"] and muon.url.startswith("https://job-boards.greenhouse.io/")
    assert muon.date_posted == "2026-11-14"


def test_speedyapply_international_file():
    listings = parse_readme(sample("speedyapply_INTERN_INTL.md"), "SpeedyApply", TODAY)
    assert len(listings) == 2
    assert all(x.locations and x.url.startswith("https://") for x in listings)


def test_simplify_html_table_follows_its_conventions():
    listings = parse_readme(sample("simplify_README.md"), "Simplify", TODAY)
    companies = [x.company for x in listings]
    assert "↳" not in companies, "a continuation row repeats the company above it"
    assert len(listings) == 5, "the closed (🔒) row is dropped"
    many = next(x for x in listings if len(x.locations) > 2)
    assert "locations" not in " ".join(many.locations), "the <details> summary isn't a place"
    assert any(len(x.locations) == 2 for x in listings), "<br> splits places"
    assert all("utm_source" in x.url for x in listings), "the link is kept as given"
    assert all("utm_source" not in x.id for x in listings)


def test_ages_become_dates():
    assert age_to_date("0d", TODAY) == TODAY
    assert age_to_date("12d", TODAY) == date(2026, 11, 2)
    assert age_to_date("2mo", TODAY) == date(2026, 9, 15)
    assert age_to_date("soon", TODAY) is None


# -- both repos together --------------------------------------------------------


def test_canonical_url_drops_tracking_only():
    assert canonical_url("https://Jobs.Example.com/a/1/?utm_source=Simplify&ref=Simplify") == "https://jobs.example.com/a/1"
    assert canonical_url("https://boards.greenhouse.io/embed/job_app?token=79&utm_medium=x") == (
        "https://boards.greenhouse.io/embed/job_app?token=79"
    )


def test_a_posting_in_both_repos_is_listed_once_with_both_sources():
    simplify = parse_listings_json(SIMPLIFY_JSON, "Simplify")
    speedy = parse_readme(sample("speedyapply_README.md"), "SpeedyApply", TODAY)
    merged = merge([simplify, speedy])
    both = [x for x in merged if len(x.sources) == 2]
    assert len(both) == 1 and both[0].company == "Chicago Trading Company"
    assert both[0].sources == ["Simplify", "SpeedyApply"]
    assert len(merged) == len(simplify) + len(speedy) - 1
    assert [x.date_posted for x in merged] == sorted((x.date_posted for x in merged), reverse=True), "newest first"


def test_simplify_prefers_its_json_and_falls_back_to_its_readme(saved_files):
    from_json = fetch_source(SIMPLIFY, TODAY)
    assert len(from_json) == 8
    del saved_files[SIMPLIFY.data_url]
    from_readme = fetch_source(SIMPLIFY, TODAY)
    assert len(from_readme) == 5
    assert {x.url for x in from_readme} == {x.url for x in parse_readme(sample("simplify_README.md"), "Simplify", TODAY)}


def test_vanshb03_prefers_its_json(saved_files):
    assert len(fetch_source(VANSH, TODAY)) == 4
    del saved_files[VANSH.data_url]
    assert len(fetch_source(VANSH, TODAY)) == 3


def test_speedyapply_reads_both_internship_files(saved_files):
    assert len(fetch_source(SPEEDYAPPLY, TODAY)) == 6 + 2


# -- the cache, offline use and the "New" badge -----------------------------------


def test_refresh_saves_listings_for_offline_use(tmp_path, saved_files):
    cache = JobsCache(tmp_path / "jobs.json")
    state = cache.refresh(today=TODAY)
    assert state.fetched_at and not state.errors
    # 8 from Simplify, 4 from vanshb03, 8 from SpeedyApply; two are listed twice.
    assert len(state.listings) == 8 + 4 + 8 - 2
    saved_files.clear()  # offline from here on
    again = JobsCache(tmp_path / "jobs.json").refresh(today=TODAY)
    assert len(again.errors) == 3
    assert again.fetched_at == state.fetched_at, "the last good fetch is kept"
    assert [x.id for x in again.listings] == [x.id for x in state.listings]


def test_a_failing_repo_keeps_its_last_listings(tmp_path, saved_files):
    cache = JobsCache(tmp_path / "jobs.json")
    cache.refresh(today=TODAY)
    for url in SPEEDYAPPLY.readme_urls:
        del saved_files[url]
    state = cache.refresh(today=TODAY)
    assert list(state.errors) == ["SpeedyApply"]
    assert sum(1 for x in state.listings if "SpeedyApply" in x.sources) == 8


def test_new_badge_marks_only_listings_first_seen_since_the_last_visit(tmp_path, saved_files):
    cache = JobsCache(tmp_path / "jobs.json")
    first = cache.start_visit()
    first = cache.refresh(today=TODAY)
    assert not any(is_new(x, first) for x in first.listings), "nothing is new on the first visit"

    # A later visit, after the repo gained a listing.
    state = cache.load()
    state.visit_at = state.fetched_at = "2026-11-14T08:00:00+00:00"
    for x in state.listings:
        x.first_seen_at = "2026-11-14T08:00:00+00:00"
    cache.save(state)
    extra = dict(SIMPLIFY_JSON[0], id="new-one", url="https://jobs.example.com/new-intern", company_name="Newco")
    saved_files[SIMPLIFY.data_url] = json.dumps([*SIMPLIFY_JSON, extra])
    cache.start_visit()
    state = cache.refresh(today=TODAY)
    new = [x.company for x in state.listings if is_new(x, state)]
    assert new == ["Newco"]


# -- through the bridge ----------------------------------------------------------


@pytest.fixture
def bridge(tmp_path):
    db = Db(":memory:")
    b = Bridge(Backend(tmp_path / "private", db, MemoryStore()))
    yield b
    db.close()


def test_jobs_commands(bridge, saved_files):
    opened = bridge.call("jobs_open", {})["ok"]
    assert opened["listings"] == [] and opened["fetched_at"] is None
    refreshed = bridge.call("jobs_refresh", {})["ok"]
    assert len(refreshed["listings"]) == 18 and refreshed["new_ids"] == []
    listing = refreshed["listings"][0]
    assert set(listing) >= {"company", "role", "locations", "date_posted", "url", "sources"}

    applied = bridge.call("mark_applied", {"company": listing["company"], "role": listing["role"], "url": listing["url"]})
    assert applied["ok"]["status"] == "applied" and applied["ok"]["url"] == listing["url"]
    again = bridge.call("mark_applied", {"company": listing["company"], "role": listing["role"], "url": listing["url"]})
    assert again["ok"]["id"] == applied["ok"]["id"], "a second click doesn't add a second entry"
    assert len(bridge.call("list_applications", {})["ok"]) == 1
    assert bridge.call("jobs_open", {})["ok"]["applied_urls"] == [listing["url"]]


def test_refresh_with_nothing_cached_and_no_network_says_so(bridge, saved_files):
    saved_files.clear()
    out = bridge.call("jobs_refresh", {})
    assert out["error"]["kind"] == "offline"
    assert "Could not load the listings" in out["error"]["message"]


def test_job_posting_reads_a_page_or_says_it_cannot(bridge, monkeypatch):
    from app.importers import web

    long_text = "Software Engineer Intern at Example. " * 40
    monkeypatch.setattr(web, "read_url", lambda url: web.Page(url=url, title="Intern", text=long_text))
    out = bridge.call("job_posting", {"url": "https://jobs.example.com/1"})["ok"]
    assert out["ok"] is True and out["text"].startswith("Software Engineer Intern")

    # A page built in the browser, such as Workday's, has almost no text.
    monkeypatch.setattr(web, "read_url", lambda url: web.Page(url=url, title="Workday", text="Loading"))
    out = bridge.call("job_posting", {"url": "https://x.wd5.myworkdayjobs.com/job/1"})["ok"]
    assert out["ok"] is False and "paste" not in out["reason"].lower()

    def blocked(url):
        raise web.ReadError("http", "The page answered with HTTP 403.")

    monkeypatch.setattr(web, "read_url", blocked)
    out = bridge.call("job_posting", {"url": "https://jobs.example.com/2"})["ok"]
    assert out == {"ok": False, "text": "", "reason": "The page answered with HTTP 403."}


def test_start_run_takes_the_role(bridge, tmp_path):
    tex = tmp_path / "resume.tex"
    tex.write_text((Path(__file__).parent / "fixtures" / "sample_resume.tex").read_text(encoding="utf-8"))
    bridge.call("import_base_resume", {"path": str(tex)})
    posting = (Path(__file__).parent / "fixtures" / "sample_posting.txt").read_text(encoding="utf-8")
    run = bridge.call("start_run", {"posting": posting, "company": "Newco", "role": "Platform Intern"})["ok"]
    assert (run["company"], run["role"]) == ("Newco", "Platform Intern")


def test_open_url_only_opens_web_links(bridge, monkeypatch):
    import webbrowser

    opened = []
    monkeypatch.setattr(webbrowser, "open", opened.append)
    assert "ok" in bridge.call("open_url", {"url": "https://jobs.example.com/1"})
    assert bridge.call("open_url", {"url": "file:///etc/passwd"})["error"]["kind"] == "invalid"
    assert opened == ["https://jobs.example.com/1"]
