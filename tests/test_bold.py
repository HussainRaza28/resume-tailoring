"""Bold in bullets survives a rewrite, and only allowed new bold is added."""

from app.core.bold import bold_phrases, keep_bold, strip_bold
from app.core.facts import FactsBank
from app.core.pipeline import OK, UNCHANGED, Context
from app.core.schemas import Proposal
from app.core.tex import SetText, TexDoc
from tests.test_pipeline import SAMPLE

OLD = "Built a Python service that batches route updates, cutting API calls from **12,000 to 3,000 per day**"


def test_markers_parse_and_strip():
    assert bold_phrases(OLD) == ["12,000 to 3,000 per day"]
    assert "**" not in strip_bold(OLD)


def test_bold_is_kept_on_a_phrase_that_survives():
    new = "Cut API calls from 12,000 to 3,000 per day with a Python service that batches route updates"
    assert keep_bold(OLD, new) == (
        "Cut API calls from **12,000 to 3,000 per day** with a Python service that batches route updates")


def test_bold_goes_when_the_phrase_does():
    old = "Added **PostgreSQL indexes** to the lookup query"
    assert keep_bold(old, "Sped up the lookup query with PostgreSQL") == "Sped up the lookup query with PostgreSQL"


def test_the_model_may_bold_the_key_result_from_the_original():
    old = "Built a Python service that cut API calls from 12,000 to 3,000 per day"
    new = "Cut API calls from **12,000 to 3,000 per day** with a Python service"
    assert keep_bold(old, new) == new


def test_new_bold_must_use_words_from_the_original():
    old = "Built a Python service that cut API calls from 12,000 to 3,000 per day"
    new = "Cut API calls **dramatically** from 12,000 to 3,000 per day with a Python service"
    assert "**" not in keep_bold(old, new)


def test_only_one_short_new_phrase():
    old = "Built a Python service that cut API calls from 12,000 to 3,000 per day"
    new = "**Cut API calls** from **12,000 to 3,000 per day** with a **Python service**"
    assert keep_bold(old, new).count("**") == 2
    long_bold = "**Built a Python service that cut API calls from 12,000 to 3,000 per day**"
    assert "**" not in keep_bold(old, long_bold)


def _bold_ctx():
    src = SAMPLE.replace(
        "cutting API calls to the mapping provider from 12,000 to 3,000 per day}",
        "cutting API calls to the mapping provider from \\textbf{12,000 to 3,000 per day}}",
    )
    assert src != SAMPLE
    return Context(src)


def test_a_rewrite_keeps_the_templates_bold_and_writes_textbf():
    ctx = _bold_ctx()
    assert "**12,000 to 3,000 per day**" in ctx.doc.text("b2")
    # The model dropped the markers, as models given plain text tend to.
    r = ctx.check(Proposal(bullet_id="b2", sources=["b2"], why="", new_text=(
        "Cut API calls to the mapping provider from 12,000 to 3,000 per day by building a Python service that "
        "batches delivery route updates")), FactsBank())
    assert r.status == OK, r.reasons
    assert "**12,000 to 3,000 per day**" in r.new_text
    tex = ctx.doc.apply([SetText(slot="b2", text=r.new_text)])
    assert "\\textbf{12,000 to 3,000 per day}" in tex
    TexDoc.parse(tex)


def test_a_bold_only_change_is_no_change():
    ctx = Context(SAMPLE)
    old = ctx.doc.text("b2")
    r = ctx.check(Proposal(bullet_id="b2", sources=["b2"], why="", new_text=old.replace(
        "12,000 to 3,000 per day", "**12,000 to 3,000 per day**")), FactsBank())
    assert r.status == UNCHANGED
    assert r.new_text == old
