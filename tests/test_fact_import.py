"""Tests for the facts import: reading files and pages, and checking suggested facts."""

import base64
import io
import json
from pathlib import Path

import pytest
from docx import Document

from app.bridge import Backend, Bridge
from app.core.db import Db
from app.core.fact_import import MAX_CHARS, covered_by, known_sources, suggest_facts
from app.core.facts import FactsBank
from app.core.tex import TexDoc
from app.core.secrets import MemoryStore
from app.importers.files import ReadError, extract_text
from app.importers.web import check_url, page_from_html, read_url
from tests.fake_provider import FakeProvider
from tests.http_stub import Stub

ROOT = Path(__file__).parent.parent
SAMPLE_TEX = (ROOT / "tests" / "fixtures" / "sample_resume.tex").read_text(encoding="utf-8")
SAMPLE_PDF = (ROOT / "ui" / "public" / "mock" / "sample-base.pdf").read_bytes()
NOTES = "TrailMap is used by 140 members of the hiking club.\nBudget Bot reads CSV exports from 3 banks.\n"


def docx_bytes(paragraphs, table=None):
    doc = Document()
    for p in paragraphs:
        doc.add_paragraph(p)
    if table:
        t = doc.add_table(rows=len(table), cols=len(table[0]))
        for i, row in enumerate(table):
            for j, cell in enumerate(row):
                t.cell(i, j).text = cell
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


# -- reading files ------------------------------------------------------------


def test_reads_pdf_docx_text_and_markdown():
    assert "Jordan Sample" in extract_text("resume.pdf", SAMPLE_PDF)
    text = extract_text("notes.docx", docx_bytes(["Built TrailMap for 140 members"], [["Role", "Intern"]]))
    assert "Built TrailMap for 140 members" in text and "Role | Intern" in text
    assert extract_text("notes.txt", NOTES.encode()) == NOTES.strip()
    assert extract_text("NOTES.MD", b"# Projects\n- TrailMap  \n") == "# Projects\n- TrailMap"


@pytest.mark.parametrize(
    ("name", "data", "kind"),
    [
        ("photo.png", b"x", "unsupported"),
        ("blank.txt", b"   \n", "empty"),
        ("broken.pdf", b"not a pdf", "unreadable"),
        ("broken.docx", b"not a zip", "unreadable"),
        ("huge.txt", b"a" * 10_000_001, "too_big"),
    ],
)
def test_unreadable_files_say_why(name, data, kind):
    with pytest.raises(ReadError) as err:
        extract_text(name, data)
    assert err.value.kind == kind


# -- reading web pages ----------------------------------------------------------

PAGE = """<html><head><title>Jordan Sample</title><script>var x = 1;</script></head><body>
<nav>Home | Blog</nav>
<h1>Projects</h1><p>TrailMap is used by 140 members of the hiking club.</p>
<a href="/files/jordan-resume.pdf">Download</a>
<a href="https://example.com/cv">My CV</a>
<a href="/about">About</a>
<footer>(c) 2026</footer></body></html>"""


def test_page_text_and_resume_links():
    page = page_from_html("https://jordan.example/", PAGE)
    assert page.title == "Jordan Sample"
    assert "TrailMap is used by 140 members" in page.text
    assert "var x" not in page.text and "Home | Blog" not in page.text and "(c) 2026" not in page.text
    assert page.pdf_links == [
        {"url": "https://jordan.example/files/jordan-resume.pdf", "label": "Download"},
        {"url": "https://example.com/cv", "label": "My CV"},
    ]


def test_urls_are_checked():
    assert check_url("jordan.example") == "https://jordan.example"
    for bad in ("ftp://x.example/a", "file:///etc/passwd", "https://"):
        with pytest.raises(ReadError):
            check_url(bad)


@pytest.fixture
def stub_factory():
    stubs = []

    def make(replies):
        stubs.append(Stub(replies))
        return stubs[-1]

    yield make
    for s in stubs:
        s.close()


def test_read_url_handles_pages_pdfs_and_errors(stub_factory):
    stub = stub_factory([(200, "text/html; charset=utf-8", PAGE)])
    page = read_url(stub.url + "/")
    assert "TrailMap" in page.text and page.pdf_links
    assert "tailor" in stub.requests[-1]["headers"]["user-agent"].lower()

    stub = stub_factory([(200, "application/pdf", SAMPLE_PDF)])
    assert "Jordan Sample" in read_url(stub.url + "/resume.pdf").text

    stub = stub_factory([(404, "text/html", "missing")])
    with pytest.raises(ReadError) as err:
        read_url(stub.url + "/gone")
    assert err.value.kind == "http"
    with pytest.raises(ReadError) as err:
        read_url("http://127.0.0.1:9/")
    assert err.value.kind == "offline"


# -- checking suggestions -------------------------------------------------------


def reply(*facts):
    return {"facts": [{"text": t, "quote": t} for t in facts]}


def test_suggestions_are_checked_against_the_document():
    p = FakeProvider().reply("suggest_facts", reply(
        "TrailMap is used by 140 members of the hiking club",
        "TrailMap is used by 400 members of the hiking club",
        "Budget Bot reads CSV exports from 3 banks using Rust",
    ))
    result = suggest_facts(p, "notes.txt", NOTES, FactsBank())
    supported = {s.text: s.supported for s in result.suggestions}
    assert supported["TrailMap is used by 140 members of the hiking club"] is True
    assert supported["TrailMap is used by 400 members of the hiking club"] is False
    bad = next(s for s in result.suggestions if "Rust" in s.text)
    assert bad.supported is False and bad.reasons == ['Skill "Rust" is not in the document.']


def test_known_facts_are_marked_and_repeats_dropped():
    bank = FactsBank()
    bank.add("TrailMap is used by 140 members of the hiking club")
    p = FakeProvider().reply("suggest_facts", reply(
        "TrailMap is used by 140 members of the hiking club",
        "Budget Bot reads CSV exports from 3 banks",
        "Budget Bot  reads CSV exports from 3 banks",
    ))
    result = suggest_facts(p, "notes.txt", NOTES, bank)
    assert [s.duplicate for s in result.suggestions] == [True, False]
    assert "TrailMap is used by 140 members" in p.calls[0].context, "saved facts are sent so they aren't repeated"


def test_long_documents_are_cut_and_say_so():
    p = FakeProvider().reply("suggest_facts", reply())
    result = suggest_facts(p, "big.txt", "x " * MAX_CHARS, FactsBank())
    assert result.truncated is True
    assert len(p.calls[0].user) < MAX_CHARS + 2000


# -- only facts that add something new ---------------------------------------


def test_a_fact_the_resume_already_states_is_covered_by_that_bullet():
    known = known_sources(TexDoc.parse(SAMPLE_TEX), FactsBank())
    # The bullet says 140 members of the university hiking club, and "TrailMap" is its project heading.
    found = covered_by("TrailMap had 140 users from the university hiking club", known)
    assert found is not None and found[0] == "b8" and found[1] == "resume"
    assert covered_by("Budget Bot reads CSV exports from 3 banks", known)[0] == "b11"


def test_a_fact_with_anything_new_is_not_covered():
    known = known_sources(TexDoc.parse(SAMPLE_TEX), FactsBank())
    assert covered_by("TrailMap had 400 users from the university hiking club", known) is None, "a new number"
    assert covered_by("Used Redis to cache route lookups at Northwind", known) is None, "a new skill"
    assert covered_by("Budget Bot has 25 weekly users", known) is None
    # Nothing to check but words: one shared word out of two isn't enough.
    assert covered_by("Enjoys hiking", known) is None


def test_a_fact_the_facts_bank_already_states_is_covered_by_that_fact():
    bank = FactsBank()
    fid = bank.add("Used Redis to cache route lookups at Northwind Logistics")
    found = covered_by("Cached route lookups in Redis at Northwind Logistics", known_sources(None, bank))
    assert found == (fid, "facts", "Used Redis to cache route lookups at Northwind Logistics")


def test_suggestions_say_what_already_covers_them():
    bank = FactsBank()
    bank.add("Used Redis to cache route lookups at Northwind Logistics")
    p = FakeProvider().reply("suggest_facts", reply(
        "TrailMap is used by 140 members of the hiking club",
        "Budget Bot reads CSV exports from 3 banks",
        "Budget Bot has 25 weekly users",
        "Used Redis to cache route lookups at Northwind Logistics",
    ))
    notes = NOTES + "Budget Bot has 25 weekly users. Used Redis to cache route lookups at Northwind Logistics.\n"
    result = suggest_facts(p, "notes.txt", notes, bank, resume=TexDoc.parse(SAMPLE_TEX))
    cover = {s.text: (s.covered_by, s.covered_in) for s in result.suggestions}
    assert cover["TrailMap is used by 140 members of the hiking club"] == ("b8", "resume")
    assert cover["Budget Bot reads CSV exports from 3 banks"] == ("b11", "resume")
    assert cover["Budget Bot has 25 weekly users"] == (None, None)
    assert cover["Used Redis to cache route lookups at Northwind Logistics"] == ("f1", "facts")
    covered = next(s for s in result.suggestions if s.covered_by == "b8")
    assert "140 members of the university hiking club" in covered.covered_text
    request = p.calls[0]
    assert "<resume>" in request.context and "used by 140 members" in request.context
    assert "already cover" in request.user


# -- through the bridge -------------------------------------------------------


@pytest.fixture
def bridge(tmp_path):
    db = Db(":memory:")
    b = Bridge(Backend(tmp_path / "private", db, MemoryStore()))
    b.call("set_setting", {"key": "provider", "value": "demo"})
    yield b
    db.close()


def test_file_import_suggests_but_saves_nothing(bridge):
    data = base64.b64encode(NOTES.encode()).decode()
    out = bridge.call("suggest_facts_from_file", {"name": "notes.txt", "data": data, "onEvent": "ch1"})
    assert "ok" in out, out
    texts = [s["text"] for s in out["ok"]["suggestions"]]
    assert "TrailMap is used by 140 members of the hiking club" in texts
    assert all(s["supported"] for s in out["ok"]["suggestions"])
    assert bridge.call("list_facts", {})["ok"] == [], "nothing is saved until the user accepts"


def test_file_import_checks_against_the_base_resume(bridge, tmp_path):
    tex = tmp_path / "resume.tex"
    tex.write_text(SAMPLE_TEX, encoding="utf-8")
    assert "ok" in bridge.call("import_base_resume", {"path": str(tex)})
    data = base64.b64encode(NOTES.encode()).decode()
    out = bridge.call("suggest_facts_from_file", {"name": "notes.txt", "data": data})["ok"]
    cover = {s["text"]: s["covered_by"] for s in out["suggestions"]}
    assert cover["TrailMap is used by 140 members of the hiking club"] == "b8"


def test_bad_file_reports_its_reason(bridge):
    out = bridge.call("suggest_facts_from_file", {"name": "photo.png", "data": base64.b64encode(b"x").decode()})
    assert out["error"]["kind"] == "unsupported"
    out = bridge.call("suggest_facts_from_file", {"name": "notes.txt", "data": "%%%"})
    assert out["error"]["kind"] == "invalid"


def test_url_import_lists_resume_links(bridge, stub_factory):
    stub = stub_factory([(200, "text/html", PAGE)])
    out = bridge.call("suggest_facts_from_url", {"url": stub.url + "/"})
    assert "ok" in out, out
    assert out["ok"]["source"] == "Jordan Sample"
    assert out["ok"]["pdf_links"][0]["url"].endswith("/files/jordan-resume.pdf")
    assert out["ok"]["suggestions"][0]["text"] == "TrailMap is used by 140 members of the hiking club"
