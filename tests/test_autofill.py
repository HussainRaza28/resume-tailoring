"""The base resume as a profile for the Tailor Autofill extension."""

import json
from pathlib import Path

from app.core.autofill import autofill_profile, contact, date_range, month_year
from app.core.facts import FactsBank
from tests.test_bridge import Harness

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE = (FIXTURES / "sample_resume.tex").read_text(encoding="utf-8")
# The extension's import test reads this same file, so the two sides agree on the format.
EXTENSION_SAMPLE = Path(__file__).parent.parent / "extension" / "test" / "fixtures" / "tailor-autofill-profile.json"


def _facts() -> FactsBank:
    bank = FactsBank()
    bank.add("TrailMap is also used by 12 trail guides")
    return bank


def test_dates():
    assert month_year("June 2025") == "2025-06"
    assert month_year("Sept. 2023") == "2023-09"
    assert month_year("05/2027") == "2027-05"
    assert month_year("Fall 2025") == "2025-09"
    assert month_year("2025") == ""
    assert date_range("June 2025 -- August 2025") == ("2025-06", "2025-08", False)
    assert date_range("Sep 2023 – Present") == ("2023-09", "", True)
    assert date_range("Expected May 2027") == ("", "2027-05", False)


def test_contact_from_the_header():
    assert contact(SAMPLE) == {
        "firstName": "Jordan",
        "lastName": "Sample",
        "email": "jordan.sample@example.com",
        "phone": "555-010-0199",
        "linkedin": "https://www.linkedin.com/in/jordan-sample",
        "github": "https://github.com/jordan-sample",
        "portfolio": "",
        "websites": [],
    }


def test_the_sample_resume():
    data = autofill_profile(SAMPLE, _facts())
    p = data["profile"]
    assert data["format"] == "tailor-autofill-profile" and data["version"] == 1
    assert p["education"] == [
        {"school": "State University", "degree": "Bachelor of Science", "field": "Computer Science", "minor": "Statistics",
         "gpa": "", "start": "", "end": "2027-05"}
    ]
    assert [(w["company"], w["title"], w["start"], w["end"], w["current"]) for w in p["work"]] == [
        ("Northwind Logistics", "Software Engineering Intern, Routing Team", "2025-06", "2025-08", False),
        ("Springfield Public Library", "Student Technology Assistant", "2023-09", "2025-05", False),
    ]
    assert p["work"][0]["location"] == "Chicago, IL"
    assert len(p["work"][0]["bullets"]) == 4 and p["work"][0]["bullets"][1].startswith("Added PostgreSQL indexes")
    # Projects aren't jobs.
    assert all("TrailMap" not in w["company"] for w in p["work"])
    assert p["skills"][:3] == ["Python", "TypeScript", "JavaScript"] and "GitHub Actions" in p["skills"]
    assert data["facts"] == ["TrailMap is also used by 12 trail guides"]


def test_title_first_headings_current_roles_and_gpa():
    tex = SAMPLE.replace(
        "{Springfield Public Library}{September 2023 -- May 2025}\n      {Student Technology Assistant}{Springfield, IL}",
        "{Student Technology Assistant}{September 2023 -- Present}\n      {Springfield Public Library}{Springfield, IL}",
    ).replace("$|$ Minor in Statistics}", "$|$ Minor in Statistics $|$ GPA: 3.8/4.0}")
    p = autofill_profile(tex, FactsBank())["profile"]
    library = p["work"][1]
    assert (library["company"], library["title"], library["current"], library["end"]) == (
        "Springfield Public Library", "Student Technology Assistant", True, "")
    assert p["education"][0]["gpa"] == "3.8/4.0"


def test_bold_is_dropped_from_bullets():
    tex = SAMPLE.replace("from 12,000 to 3,000 per day}", "from \\textbf{12,000 to 3,000 per day}}")
    assert "**" not in autofill_profile(tex, FactsBank())["profile"]["work"][0]["bullets"][0]


def test_the_extension_sample_is_this_exports_output():
    """Regenerate with: python -c 'from tests.test_autofill import write_sample; write_sample()'"""
    assert json.loads(EXTENSION_SAMPLE.read_text(encoding="utf-8")) == autofill_profile(SAMPLE, _facts())


def write_sample() -> None:
    EXTENSION_SAMPLE.write_text(json.dumps(autofill_profile(SAMPLE, _facts()), indent=2) + "\n", encoding="utf-8")


def test_export_through_the_bridge(tmp_path):
    h = Harness(tmp_path)
    try:
        assert h.err("autofill_profile")["kind"] == "no_base_resume"
        h.ok("import_base_resume", path=str(FIXTURES / "sample_resume.tex"))
        out = tmp_path / "profile.json"
        assert h.ok("export_autofill", path=str(out)) == str(out)
        saved = json.loads(out.read_text(encoding="utf-8"))
        assert saved["profile"]["firstName"] == "Jordan"
        # No window in tests: without a path there's no dialog to ask, so nothing is saved.
        assert h.ok("export_autofill") is None
    finally:
        h.db.close()
