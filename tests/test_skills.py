"""Tests for skill matching, posting tiers and keyword coverage."""

from app.core.skills import (
    PostingSkills,
    coverage,
    extract_posting_skills,
    lexicon,
)


def find(text):
    return lexicon().find(text)


def test_lexicon_loads():
    entries = lexicon().entries
    assert len(entries) > 250
    assert all(e.patterns for e in entries)


def test_whole_token_matching():
    assert find("Experience with Go and Kubernetes") == ["Go", "Kubernetes"]
    assert find("Golang, k8s") == ["Go", "Kubernetes"]
    assert find("We go fast") == []
    assert find("Node.js services") == ["Node.js"]
    assert "Swift" not in find("Node.js")
    assert find("C++ and C#") == ["C++", "C#"]
    assert "C" not in find("C++")
    assert find("javascript") == ["JavaScript"]
    assert "Java" not in find("JavaScript")
    assert find("Postgres") == ["PostgreSQL"]
    assert find("end-to-end tests") == ["End-to-End Testing"]


def test_ambiguous_words_need_the_right_case_or_context():
    assert "Spring Boot" not in find("Spring 2026")
    assert "Express" not in find("express interest in the role")
    assert "C" not in find("Series C startup")
    assert "C" in find("Proficient in C, Java")
    assert "R" in find("Python, Java, Go, Swift, JavaScript, SQL, C, R")
    assert "R" not in find("R&D team")
    assert "R" in find("experience in R")


POSTING = (
    "Software Engineer Intern\nAbout us\nWe use Rust everywhere.\n\n"
    "Minimum Qualifications:\n- Experience with Python or Java\n"
    "- Familiarity with SQL databases is a plus\n- Kubernetes\n\n"
    "Preferred Qualifications\n- Go\n- AWS\n- Python\n\n"
    "Benefits\n- Free Docker stickers\n"
)


def test_posting_tiers():
    p = extract_posting_skills(POSTING)
    assert p.required == ["Python", "Java", "Kubernetes"]
    assert p.preferred == ["Go", "SQL", "AWS"]
    assert p.mentioned == ["Rust", "Docker"]


def test_posting_without_headings_counts_everything_as_required():
    p = extract_posting_skills("We want someone who knows React and TypeScript.")
    assert p.required == ["TypeScript", "React"]
    assert p.preferred == []


def test_heading_line_can_list_skills():
    p = extract_posting_skills("Skills: Python, SQL\nNice to have\n- Docker")
    assert p.required == ["Python", "SQL"]
    assert p.preferred == ["Docker"]


def test_sample_posting_fixture():
    from pathlib import Path

    text = (Path(__file__).parent / "fixtures" / "sample_posting.txt").read_text(encoding="utf-8")
    p = extract_posting_skills(text)
    assert "Python" in p.required
    assert not set(p.required) & set(p.preferred)


def test_coverage_counts_only_real_skills():
    p = PostingSkills(required=["Python", "Go", "Rust", "Kubernetes"], preferred=["AWS"])
    base = "Built agents in Go on Kubernetes. Languages: Python, Go"
    facts = [("f1", "Wrote a small CLI in Rust for log parsing")]
    tailored = "Built agents in Go on Kubernetes using Python"
    c = coverage(p, tailored, base, facts)
    assert (c.required_total, c.required_have, c.required_covered) == (4, 4, 3)
    assert c.required_pct() == 0.75
    rust = next(s for s in c.skills if s.skill == "Rust")
    assert rust.addable
    assert rust.evidence == "f1"
    aws = next(s for s in c.skills if s.skill == "AWS")
    assert not aws.have and not aws.addable, "AWS is in neither the base resume nor the facts bank"
    assert c.preferred_pct() is None


def test_invented_skill_in_resume_does_not_count():
    c = coverage(PostingSkills(required=["Rust"]), "Wrote Rust services", "Wrote Go services", [])
    assert c.required_covered == 0
    assert c.required_pct() is None
