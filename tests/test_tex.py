"""Tests for the template engine. Most of these check that only slot text can change."""

from pathlib import Path

import pytest
from pydantic import TypeAdapter

from app.core.tex import (
    BadRaw,
    Edit,
    ForbiddenCommand,
    Remove,
    ReorderSkills,
    SetRaw,
    SetText,
    SkeletonChanged,
    SkillsMismatch,
    TexDoc,
    UnknownSlot,
    WrongKind,
    plain_to_tex,
    split_skills,
    tex_to_plain,
    verify_preserved,
)

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE = (FIXTURES / "sample_resume.tex").read_text(encoding="utf-8")
PRIVATE_RESUME = Path(__file__).parent.parent / "data" / "private" / "base_resume.tex"


@pytest.fixture
def doc() -> TexDoc:
    return TexDoc.parse(SAMPLE)


def test_finds_sections_in_order(doc):
    assert doc.sections == ["Education", "Experience", "Projects", "Technical Skills"]


def test_finds_every_bullet_and_ignores_preamble_definitions(doc):
    # 1 coursework + 4 + 2 experience + 2 + 2 project bullets
    assert len(doc.bullets()) == 11
    body = SAMPLE.find("\\begin{document}")
    assert all(s.start > body for s in doc.bullets())
    assert len(doc.bullets_in(["experience", "projects"])) == 10


def test_groups_bullets_under_headings(doc):
    assert len(doc.entries) == 5
    north = doc.entries[1]
    assert north.section == "Experience"
    assert len(north.bullets) == 4
    assert doc.entry_title(1) == "Northwind Logistics | Software Engineering Intern, Routing Team"
    assert doc.entry_title(3) == "**TrailMap** | *TypeScript, React, Node.js, PostgreSQL*"
    assert doc.text(north.bullets[0]).startswith("Built a Python service")


def test_reads_skills_lines(doc):
    skills = doc.skills()
    assert len(skills) == 3
    assert skills[0] == ("Languages", ["Python", "TypeScript", "JavaScript", "Java", "SQL"])
    assert skills[1][0] == "Frameworks & Libraries"


def test_skills_split_respects_parentheses():
    assert split_skills("AWS (CloudWatch, Bedrock), Docker,Git") == ["AWS (CloudWatch, Bedrock)", "Docker", "Git"]


def test_no_edits_is_identity(doc):
    assert doc.apply([]) == SAMPLE


def test_round_trip_is_byte_for_byte():
    # Read and write as bytes, so line endings and encoding are checked too.
    raw = (FIXTURES / "sample_resume.tex").read_bytes()
    out = TexDoc.parse(raw.decode("utf-8")).apply([])
    assert out.encode("utf-8") == raw


def test_unchanged_text_keeps_original_bytes(doc):
    edits = [SetText(slot=s.id, text=doc.text(s.id)) for s in doc.bullets()]
    assert doc.apply(edits) == SAMPLE


def test_plain_round_trip_for_every_slot(doc):
    for s in doc.slots:
        raw = doc.raw(s.id)
        plain = tex_to_plain(raw)
        if plain is not None:
            assert plain_to_tex(plain) == raw, s.id


def test_editing_a_bullet_changes_only_that_bullet(doc):
    out = doc.apply([SetText(slot="b2", text="Cut mapping API calls from 12,000 to 3,000 per day & more")])
    assert "\\resumeItem{Cut mapping API calls from 12,000 to 3,000 per day \\& more}" in out
    after = TexDoc.parse(out)
    assert after.text("b2") == "Cut mapping API calls from 12,000 to 3,000 per day & more"
    for s in doc.slots:
        if s.id != "b2":
            assert doc.raw(s.id) == after.raw(s.id), f"slot {s.id} changed"
    # Identical outside the edited range.
    b2 = doc.slot("b2")
    assert out[: b2.start] == SAMPLE[: b2.start]
    tail = len(SAMPLE) - b2.end
    assert out[len(out) - tail :] == SAMPLE[b2.end :]


def test_model_text_cannot_inject_latex(doc):
    evil = "Did things \\section{Hacked} }{ \\input{/etc/passwd} 50% $x$ #1 a_b ~ ^"
    out = doc.apply([SetText(slot="b3", text=evil)])
    after = TexDoc.parse(out)
    assert after.sections == doc.sections
    assert after.text("b3") == evil
    assert "\\section{Hacked}" not in out
    assert "\\input{/etc" not in out


def test_remove_bullet_drops_whole_line(doc):
    out = doc.apply([Remove(slot="b5")])
    assert "Worked with the team on various backend tasks" not in out
    assert len(TexDoc.parse(out).bullets()) == 10
    line_start, line_end = doc.slot("b5").line
    assert len(out) == len(SAMPLE) - (line_end - line_start)


def test_only_bullets_can_be_removed(doc):
    with pytest.raises(WrongKind):
        doc.apply([Remove(slot="h2.0")])
    with pytest.raises(WrongKind):
        doc.apply([Remove(slot="s1")])


def test_reorder_skills_accepts_permutation_only(doc):
    ok = doc.apply([ReorderSkills(slot="s1", items=["SQL", "Python", "Java", "TypeScript", "JavaScript"])])
    assert "\\textbf{Languages}{: SQL, Python, Java, TypeScript, JavaScript}" in ok
    with pytest.raises(SkillsMismatch):
        doc.apply([ReorderSkills(slot="s1", items=["SQL", "Python", "Java", "TypeScript", "Rust"])])
    with pytest.raises(SkillsMismatch):
        doc.apply([ReorderSkills(slot="s1", items=["SQL"])])


def test_reorder_skills_with_escaped_items():
    src = SAMPLE.replace("React, Node.js, Express", "React, Node.js, R\\&D Tools")
    out = TexDoc.parse(src).apply(
        [ReorderSkills(slot="s2", items=["R&D Tools", "React", "Node.js", "pytest", "pandas"])]
    )
    assert "{: R\\&D Tools, React, Node.js, pytest, pandas}" in out


def test_set_text_on_skills_is_rejected(doc):
    with pytest.raises(WrongKind):
        doc.apply([SetText(slot="s1", text="Python, Rust")])


def test_unknown_slot_rejected(doc):
    with pytest.raises(UnknownSlot):
        doc.apply([Remove(slot="b999")])


def test_raw_edit_must_balance(doc):
    with pytest.raises(BadRaw):
        doc.apply([SetRaw(slot="b2", tex="oops }")])
    doc.apply([SetRaw(slot="b2", tex="Built \\textbf{this}")])


def test_raw_edit_cannot_add_structure_or_spacing(doc):
    def raw(tex):
        return doc.apply([SetRaw(slot="b2", tex=tex)])

    with pytest.raises(BadRaw):
        raw("x} \\section{Summary} \\resumeItem{y")
    for bad in ["x \\section{Summary} y", "\\small tiny text", "a \\vspace{-4pt}", "\\input{x}", "line\\\\break"]:
        with pytest.raises(ForbiddenCommand):
            raw(bad)
    raw("Built \\href{https://x.dev}{\\underline{x.dev}} with 50\\% fewer calls")


@pytest.mark.parametrize(
    "tex",
    [
        "a \\textbf{x} b",
        "a \\emph{x} b",
        "a \\textit{x} b",
        "a \\underline{x} b",
        "a \\href{https://x.dev}{x} b",
        "about $\\sim$40 users",
        "a\\textbackslash{} b",
        "a \\textless{} b \\textgreater{} c",
    ],
)
def test_every_allowed_command_is_accepted(doc, tex):
    doc.apply([SetRaw(slot="b2", tex=tex)])


def test_verify_catches_preamble_change(doc):
    margin = SAMPLE.replace("\\addtolength{\\topmargin}{-.5in}", "\\addtolength{\\topmargin}{-.9in}")
    font = SAMPLE.replace("11pt", "10pt")
    renamed = SAMPLE.replace("\\section{Projects}", "\\section{Side Projects}")
    for tampered in (margin, font, renamed):
        with pytest.raises(SkeletonChanged):
            verify_preserved(doc, tampered, set())


def test_no_summary_section_can_be_added(doc):
    # Section order is locked, so no edit can add a summary section.
    added = SAMPLE.replace("\\section{Education}", "\\section{Summary}\nHire me.\n\\section{Education}")
    with pytest.raises(SkeletonChanged):
        verify_preserved(doc, added, set())


def test_conversions():
    assert tex_to_plain("Student (1 of $\\sim$230 selected)") == "Student (1 of ~230 selected)"
    assert tex_to_plain("May 2025 -- August 2025") == "May 2025 \u2013 August 2025"
    assert tex_to_plain("like ``falling pizza''") == "like \u201cfalling pizza\u201d"
    assert tex_to_plain("\\textbf{Skypane} $|$ \\emph{Swift}") == "**Skypane** | *Swift*"
    assert tex_to_plain("\\href{x}{y}") is None
    assert plain_to_tex('say "hi" now') == "say ``hi'' now"
    assert plain_to_tex("2 * 3 = 6") == "2 * 3 = 6"
    assert plain_to_tex("C++ & C#") == "C++ \\& C\\#"


def test_edits_parse_from_ui_json():
    adapter = TypeAdapter(list[Edit])
    edits = adapter.validate_python(
        [
            {"op": "set_text", "slot": "b2", "text": "x"},
            {"op": "set_raw", "slot": "b3", "tex": "\\emph{y}"},
            {"op": "remove", "slot": "b5"},
            {"op": "reorder_skills", "slot": "s1", "items": ["SQL"]},
        ]
    )
    assert [type(e) for e in edits] == [SetText, SetRaw, Remove, ReorderSkills]


@pytest.mark.skipif(not PRIVATE_RESUME.exists(), reason="no private base resume")
def test_private_base_resume_round_trips_if_present():
    src = PRIVATE_RESUME.read_text(encoding="utf-8")
    doc = TexDoc.parse(src)
    assert doc.apply([]) == src
    for s in doc.slots:
        raw = doc.raw(s.id)
        plain = tex_to_plain(raw)
        if plain is not None:
            assert plain_to_tex(plain) == raw, s.id
    assert doc.apply([SetText(slot=s.id, text=doc.text(s.id)) for s in doc.bullets()]) == src
