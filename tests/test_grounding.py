"""Tests for the grounding check: every number, name and skill in a rewrite
must appear in the sources it cites."""

from app.core.grounding import PROPER_NOUN, SKILL, Source, check


def src(sid, text):
    return Source(id=sid, text=text)


B2 = (
    "Built self-healing into Amazon CloudWatch's Kubernetes monitoring agent by adding liveness and "
    "readiness health checks in Go to 4 components, so failing parts restart automatically"
)
HEADING = "Amazon Web Services (AWS) | Software Development Engineer Intern, CloudWatch Agent Team"


def check2(new):
    return check(new, [src("b2", B2), src("heading", HEADING)])


def test_faithful_rewrite_passes():
    r = check2(
        "Added liveness and readiness health checks in Go to 4 components of the Amazon CloudWatch "
        "Kubernetes agent so failing parts restart automatically"
    )
    assert r.ok(), r.reasons()


def test_invented_number_is_blocked():
    r = check2("Cut agent downtime 40% by adding health checks in Go to 4 components")
    assert not r.ok()
    assert r.unsupported()[0].text == "40%"
    assert r.reasons() == ['Number "40%" is not in the cited sources.']


def test_small_numbers_get_no_exception():
    assert not check2("Added health checks in Go to 5 components").ok()
    assert not check2("Added health checks in Go to two components").ok(), "spelled-out numbers count too"
    assert not check2("Added health checks in Go to 1 more component").ok()


def test_number_formats_match():
    s = [src("b1", "cut calls from 12,000 to 3,000 per day; about 700 lines; 0.66 seconds; 2x faster")]
    assert check("cut calls from 12000 to 3k per day", s).ok()
    assert check("about 700 lines in 0.66 seconds", s).ok()
    assert check("made it twice as fast", s).ok(), "twice matches 2x"
    assert not check("made it 3x faster", s).ok()
    assert not check("cut calls by 75%", s).ok(), "derived percentages are not in the source"
    assert not check("cut calls by 3%", s).ok(), "a percent needs a percent in the source"


def test_invented_skill_is_blocked_and_aliases_are_fine():
    r = check2("Added health checks in Rust to 4 components")
    assert not r.ok()
    assert any(c.kind == SKILL and c.text == "Rust" for c in r.unsupported())
    assert check2("Added health checks in Golang to 4 components on k8s").ok()


def test_invented_names_are_blocked():
    r = check2("Added health checks to 4 components used by Netflix")
    assert not r.ok()
    assert r.unsupported()[0].text == "Netflix"
    assert r.unsupported()[0].kind == PROPER_NOUN
    r = check2("Won the Dean's Award for adding health checks in Go to 4 components")
    assert any(c.text == "Dean" for c in r.unsupported())


def test_heading_counts_as_a_source():
    assert check2("Added Go health checks to 4 AWS CloudWatch agent components").ok()


def test_heading_only_backs_its_own_role():
    other_heading = "Northwind Logistics | Software Engineering Intern"
    r = check("Added health checks in Go to 4 components at Northwind", [src("b2", B2), src("heading", HEADING)])
    assert not r.ok()
    assert check(
        "Added health checks in Go to 4 components at Northwind", [src("b2", B2), src("heading", other_heading)]
    ).ok()


def test_citing_nothing_is_blocked():
    r = check("Built a thing", [src("heading", HEADING)])
    assert not r.ok()
    assert len(r.citation_errors) == 1


def test_facts_back_up_new_numbers():
    s = [src("b8", "Built a native macOS menu bar app"), src("f1", "Skypane has 40 beta users")]
    assert check("Built a native macOS menu bar app used by 40 beta users", s).ok()
    assert not check("Built a native macOS menu bar app used by 400 beta users", s).ok()


def test_facts_back_up_new_skills():
    s = [src("b1", "Built a caching layer for the API"), src("f1", "The caching layer used Redis")]
    assert check("Built a Redis caching layer for the API", s).ok()
    assert not check("Built a Redis caching layer for the API", s[:1]).ok()


def test_digits_inside_names_are_not_numbers():
    s = [src("b1", "Deployed to EC2 and S3 on k8s")]
    r = check("Deployed to S3 and EC2 on Kubernetes", s)
    assert r.ok(), r.reasons()


def test_sentence_start_words_are_not_names():
    s = [src("b1", "built the data models and views")]
    assert check("Shipped the data models and views", s).ok()
    assert check("Built the data models; Shipped views", s).ok()


def test_mixed_case_tokens_count_as_names():
    s = [src("b1", "Built a web app")]
    assert not check("Built a web app on DynamoDB", s).ok()
    r = check("Built a web app with an iPhone client", s)
    assert any(c.text == "iPhone" for c in r.unsupported())
