"""Tests for the style rules. Rules that depend on the original wording only
fire when the rewrite introduces the pattern."""

from app.core.style import (
    AI_MENTION,
    EM_DASH,
    LIST_OF_THREE,
    NOT_X_BUT_Y,
    SELF_COMPARISON,
    STOCK_WORD,
    UNCLEAR_NUMBER,
    check_bullet,
    is_summary_section,
)


def rules(text, sources=()):
    return [v.rule for v in check_bullet(text, list(sources))]


CLEAN = "Added liveness and readiness health checks in Go to 4 components so failing parts restart automatically"


def test_clean_bullet_passes():
    assert rules(CLEAN, [CLEAN]) == []


def test_em_dash():
    assert EM_DASH in rules("Built the agent — it restarts itself")
    assert EM_DASH in rules("Built the agent --- it restarts itself")
    assert EM_DASH in rules("Built the agent - it restarts itself")
    assert EM_DASH not in rules("Built a self-healing agent for real-time logs")
    assert EM_DASH not in rules("Ran pages 1–3 of the report")


def test_list_of_three():
    assert LIST_OF_THREE in rules("Designed, built, and shipped the messaging feature")
    assert LIST_OF_THREE in rules("Made the agent faster, safer and simpler")
    # Kept from the source, so not the rewrite's fault.
    src = "Built the data models, views, and JavaScript UI for messaging"
    assert LIST_OF_THREE not in rules("Shipped messaging by building the data models, views, and JavaScript UI", [src])
    assert LIST_OF_THREE not in rules("Built the data models and views for messaging")


def test_not_x_but_y():
    assert NOT_X_BUT_Y in rules("Not just a dashboard, but a full monitoring tool")
    assert NOT_X_BUT_Y in rules("Fixed root causes rather than patching symptoms")
    assert NOT_X_BUT_Y in rules("The agent isn't just faster")
    assert NOT_X_BUT_Y not in rules("Did not ship until tests passed")
    # A contrast that was in the source bullet may stay.
    src = "so engineers can see what broke rather than guessing"
    assert NOT_X_BUT_Y not in rules("Reported component health so engineers can see what broke rather than guessing", [src])


def test_stock_words():
    for text in ["Leveraged Go", "seamless restarts", "a robust agent", "Spearheaded testing", "delved into logs", "team synergy"]:
        assert STOCK_WORD in rules(text), text
    assert STOCK_WORD not in rules("Used Go to add health checks")
    assert rules("Robustness tests") != []


def test_unclear_numbers():
    assert UNCLEAR_NUMBER in rules("Improved the pipeline by 3 and shipped it")
    assert UNCLEAR_NUMBER in rules("Cut latency to 40")
    assert UNCLEAR_NUMBER not in rules("Cut latency by 40% across 3 services")
    assert UNCLEAR_NUMBER not in rules("Merged 3 pull requests in 2025")
    assert UNCLEAR_NUMBER not in rules("Cut API calls from 12,000 to 3,000 per day")
    assert UNCLEAR_NUMBER not in rules("Each simulation ran in 0.66 seconds")
    assert UNCLEAR_NUMBER not in rules("Saved $1,200 per month")
    assert UNCLEAR_NUMBER not in rules("Led 2 of 5 teams")


def test_numbers_inside_hyphenated_terms_have_context():
    bullet = "Built a match engine that supports best-of-3 or best-of-5 matches using a 4-letter code"
    assert UNCLEAR_NUMBER not in rules(bullet)
    assert UNCLEAR_NUMBER not in rules("Kept the service up 24/7 for the campus")
    assert UNCLEAR_NUMBER not in rules("Designed a 3-stage pipeline")
    assert UNCLEAR_NUMBER not in rules("Placed in the Top-10 and shipped it")
    assert UNCLEAR_NUMBER not in rules("Moved the data to S3 and EC2 for the team")
    # A bare number next to a hyphenated term still needs its own noun.
    assert UNCLEAR_NUMBER in rules("Ran a best-of-3 bracket and improved it by 3")
    assert UNCLEAR_NUMBER not in rules("Tracked windows up to 10 times per second")
    assert UNCLEAR_NUMBER in rules("Improved the build 3 times")
    assert UNCLEAR_NUMBER not in rules("Selected as 1 of ~230 students")


def test_self_comparison():
    assert SELF_COMPARISON in rules("Made the app 2x faster than my previous version")
    assert SELF_COMPARISON in rules("Shipped 30% more features than before")
    assert SELF_COMPARISON in rules("Raised my own test coverage by 20%")
    assert SELF_COMPARISON not in rules("Cut query time from 2 s to 200 ms")


def test_ai_mentions_only_when_source_has_them():
    assert AI_MENTION in rules("Used AI to map the codebase", ["Mapped an unfamiliar Go codebase"])
    assert AI_MENTION in rules("Built with Claude")
    src = "Used Kiro, AWS's AI coding IDE, to map an unfamiliar Go codebase"
    assert AI_MENTION not in rules("Used Kiro, AWS's AI coding IDE, to map a Go codebase", [src])
    assert AI_MENTION in rules("Used Kiro and an LLM to map a Go codebase", [src])


def test_summary_titles():
    assert is_summary_section("Professional Summary")
    assert is_summary_section("OBJECTIVE")
    assert is_summary_section("Profile")
    assert not is_summary_section("Experience")
    assert not is_summary_section("Technical Skills and Honors")
