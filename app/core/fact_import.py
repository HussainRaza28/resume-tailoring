"""Suggesting facts from a document, for the user to approve.

The selected provider reads the document's text and suggests short, specific
facts. Each suggestion is then checked in code against the document, the same
way rewrites are checked against their sources, so a number or name the
document doesn't contain is flagged.

Each one is also checked against the base resume and the facts bank. A fact
that a single bullet, skills line or saved fact already covers adds nothing,
so the interface tucks it away. Nothing is saved here: the interface shows the
suggestions and saves only the ones the user accepts.
"""

from __future__ import annotations

from pydantic import BaseModel

import re

from app.core.facts import FactsBank
from app.core.grounding import Source, check
from app.core.tex import BULLET, SKILLS_LINE, TexDoc, tex_to_plain
from app.core.schemas import Strict
from app.providers.base import CompletionRequest, DeltaSink, Provider, ignore_deltas

# Long documents are cut here, and the interface says so. A resume or a
# portfolio page is far shorter.
MAX_CHARS = 60_000

FACTS_SYSTEM = """You pull facts about one person's own work out of a document, for a facts bank that their resume tailoring draws on.

Rules:
- Only state what the document says. No new numbers, names, tools, dates or outcomes.
- Each fact is one short, specific sentence about something the person did, built or achieved, with the numbers, names and tools exactly as the document gives them. For example: "TrailMap had 140 users from the university hiking club."
- Skip opinions, duties with no detail, contact details, and anything about someone else.
- Skip anything the resume or the saved facts already say. A fact is only worth suggesting if it adds a number, name, tool or outcome they don't have.
- Write plain text. No Markdown."""


def facts_prompt(source: str, document: str) -> str:
    return (
        f"Suggest facts from this document ({source}). Return at most 15. For each, give `text`, the fact, "
        "and `quote`, the exact words in the document it comes from. Leave out facts that the resume or the saved "
        "facts already cover.\n\n"
        f"<document>\n{document}\n</document>"
    )


class SuggestedFact(Strict):
    text: str
    quote: str


class FactSuggestionsReply(Strict):
    facts: list[SuggestedFact]


class Suggestion(BaseModel):
    text: str
    quote: str
    # True when every number, name and skill in the fact is in the document.
    supported: bool
    reasons: list[str]
    # True when the facts bank already holds the same fact.
    duplicate: bool
    # What already says this, if anything: a bullet id ("b8"), a skills line id
    # ("s2") or a fact id ("f3"). A covered fact adds nothing new.
    covered_by: str | None = None
    # Where that is, for the interface: "resume" or "facts".
    covered_in: str | None = None
    # The covering text, so the user can compare.
    covered_text: str | None = None


class SuggestionResult(BaseModel):
    source: str
    truncated: bool
    suggestions: list[Suggestion]
    # Links on a web page that look like a resume PDF: {"url", "label"}.
    pdf_links: list[dict] = []


def _normalize(s: str) -> str:
    return " ".join(s.lower().split())


# Words that carry no meaning of their own when comparing two sentences.
_STOPWORDS = set(
    "a an and are as at be by for from had has have in into is it its of on or that the their this to was were "
    "with which who used using use built made i my we our".split()
)

# A fact with names or numbers is covered when one source supports all of them
# and shares at least this share of its words. With nothing to check but words,
# the bar is higher.
_OVERLAP_WITH_CLAIMS = 0.5
_OVERLAP_WORDS_ONLY = 0.8


def _content_words(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9][a-z0-9+#.]*", text.lower())
    return {w.rstrip(".") for w in words if w not in _STOPWORDS and len(w) > 1}


def _overlap(fact: str, source: str) -> float:
    """The share of the fact's words that also appear in the source."""
    mine = _content_words(fact)
    if not mine:
        return 0.0
    return len(mine & _content_words(source)) / len(mine)


def known_sources(doc: TexDoc | None, bank: FactsBank) -> list[tuple[str, str, str]]:
    """Everything the person has already said about themselves: (id, where, text).

    A bullet carries the heading of its role or project, since a fact such as
    "TrailMap had 140 users" names the project the bullet sits under.
    """
    out: list[tuple[str, str, str]] = []
    if doc is not None:
        for slot in doc.slots:
            text = doc.text(slot.id) or ""
            if slot.kind == BULLET and text:
                heading = doc.entry_title(slot.entry) if slot.entry is not None else ""
                out.append((slot.id, "resume", f"{heading}. {text}" if heading else text))
            elif slot.kind == SKILLS_LINE and text:
                label = slot.label or ""
                out.append((slot.id, "resume", f"{tex_to_plain(label) or label}: {text}"))
    out += [(f.id, "facts", f.text) for f in bank.facts]
    return out


def covered_by(fact: str, sources: list[tuple[str, str, str]]) -> tuple[str, str, str] | None:
    """The first source that already says everything ``fact`` says, or None if it adds something.

    Every number, name and skill in the fact must be in that one source (the
    same check rewrites get), and most of its words must be there too.
    """
    for sid, where, text in sources:
        report = check(fact, [Source(id=sid, text=text)])
        if not report.ok():
            continue
        bar = _OVERLAP_WITH_CLAIMS if report.claims else _OVERLAP_WORDS_ONLY
        if _overlap(fact, text) >= bar:
            return sid, where, text
    return None


def suggest_facts(
    provider: Provider,
    source: str,
    document: str,
    bank: FactsBank,
    on_delta: DeltaSink = ignore_deltas,
    resume: TexDoc | None = None,
) -> SuggestionResult:
    truncated = len(document) > MAX_CHARS
    text = document[:MAX_CHARS]
    saved = "\n".join(f"- {f.text}" for f in bank.facts) or "(none)"
    known = known_sources(resume, bank)
    on_resume = "\n".join(f"- {t}" for _sid, where, t in known if where == "resume") or "(none)"
    request = CompletionRequest(
        step="suggest_facts",
        system=FACTS_SYSTEM,
        context=f"<resume>\n{on_resume}\n</resume>\n\n<already_saved>\n{saved}\n</already_saved>",
        user=facts_prompt(source, text),
        schema=FactSuggestionsReply,
        max_tokens=4000,
    )
    reply: FactSuggestionsReply = provider.complete(request, on_delta).data
    saved_texts = {_normalize(f.text) for f in bank.facts}
    doc_source = [Source(id="document", text=text)]
    suggestions = []
    seen = set()
    for fact in reply.facts:
        fact_text = " ".join(fact.text.split())
        if not fact_text or _normalize(fact_text) in seen:
            continue
        seen.add(_normalize(fact_text))
        report = check(fact_text, doc_source)
        cover = covered_by(fact_text, known)
        suggestions.append(
            Suggestion(
                text=fact_text,
                quote=fact.quote.strip(),
                supported=report.ok(),
                reasons=[r.replace("the cited sources", "the document") for r in report.reasons()],
                duplicate=_normalize(fact_text) in saved_texts,
                covered_by=cover[0] if cover else None,
                covered_in=cover[1] if cover else None,
                covered_text=cover[2] if cover else None,
            )
        )
    return SuggestionResult(source=source, truncated=truncated, suggestions=suggestions)
