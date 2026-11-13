"""Suggesting facts from a document, for the user to approve.

The selected provider reads the document's text and suggests short, specific
facts. Each suggestion is then checked in code against the document, the same
way rewrites are checked against their sources, so a number or name the
document doesn't contain is flagged. Nothing is saved here: the interface
shows the suggestions and saves only the ones the user accepts.
"""

from __future__ import annotations

from pydantic import BaseModel

from app.core.facts import FactsBank
from app.core.grounding import Source, check
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
- Write plain text. No Markdown."""


def facts_prompt(source: str, document: str) -> str:
    return (
        f"Suggest facts from this document ({source}). Return at most 15. For each, give `text`, the fact, "
        "and `quote`, the exact words in the document it comes from. Leave out facts that are already saved.\n\n"
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


class SuggestionResult(BaseModel):
    source: str
    truncated: bool
    suggestions: list[Suggestion]
    # Links on a web page that look like a resume PDF: {"url", "label"}.
    pdf_links: list[dict] = []


def _normalize(s: str) -> str:
    return " ".join(s.lower().split())


def suggest_facts(
    provider: Provider, source: str, document: str, bank: FactsBank, on_delta: DeltaSink = ignore_deltas
) -> SuggestionResult:
    truncated = len(document) > MAX_CHARS
    text = document[:MAX_CHARS]
    saved = "\n".join(f"- {f.text}" for f in bank.facts) or "(none)"
    request = CompletionRequest(
        step="suggest_facts",
        system=FACTS_SYSTEM,
        context=f"<already_saved>\n{saved}\n</already_saved>",
        user=facts_prompt(source, text),
        schema=FactSuggestionsReply,
        max_tokens=4000,
    )
    reply: FactSuggestionsReply = provider.complete(request, on_delta).data
    known = {_normalize(f.text) for f in bank.facts}
    doc_source = [Source(id="document", text=text)]
    suggestions = []
    seen = set()
    for fact in reply.facts:
        fact_text = " ".join(fact.text.split())
        if not fact_text or _normalize(fact_text) in seen:
            continue
        seen.add(_normalize(fact_text))
        report = check(fact_text, doc_source)
        suggestions.append(
            Suggestion(
                text=fact_text,
                quote=fact.quote.strip(),
                supported=report.ok(),
                reasons=[r.replace("the cited sources", "the document") for r in report.reasons()],
                duplicate=_normalize(fact_text) in known,
            )
        )
    return SuggestionResult(source=source, truncated=truncated, suggestions=suggestions)
