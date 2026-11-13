"""Style rules, checked in code on every rewritten bullet.

Some rules depend on the original wording: lists of three, "not X but Y"
contrasts and mentions of AI tools. Those only fire when the rewrite *adds* the
pattern. If the original bullet already had it, keeping it isn't the rewrite's
fault.
"""

from __future__ import annotations

import re

from pydantic import BaseModel

EM_DASH = "em_dash"
LIST_OF_THREE = "list_of_three"
NOT_X_BUT_Y = "not_x_but_y"
STOCK_WORD = "stock_word"
UNCLEAR_NUMBER = "unclear_number"
SELF_COMPARISON = "self_comparison"
AI_MENTION = "ai_mention"

LABELS = {
    EM_DASH: "Em dash",
    LIST_OF_THREE: "List of three for rhythm",
    NOT_X_BUT_Y: '"Not X but Y" contrast',
    STOCK_WORD: "Stock word",
    UNCLEAR_NUMBER: "Number without context",
    SELF_COMPARISON: "Self-comparison stat",
    AI_MENTION: "AI mention not in the source",
}


class Violation(BaseModel):
    rule: str
    # The text that broke the rule.
    excerpt: str
    message: str


STOCK_WORDS = ["leverage", "seamless", "robust", "spearheaded", "delve", "synergy"]

_STOCK_RE = re.compile(
    r"\b(leverag(?:e|es|ed|ing)|seamless(?:ly)?|robust(?:ly|ness)?|spearhead(?:s|ed|ing)?"
    r"|delv(?:e|es|ed|ing)|synerg(?:y|ies|istic))\b",
    re.IGNORECASE,
)

# An em dash, or an en dash or hyphen with spaces around it used the same way.
# "self-healing" and "pages 1–3" don't match.
_DASH_RE = re.compile(r"—|---|\s–\s|\s--\s|\s-\s")

# "A, B, and C" or "A, B or C", where each item is one to three words.
_TRIAD_RE = re.compile(
    r"\b([a-z][\w+#.\-/]*(?: [\w+#.\-/]+){0,2}), ([\w+#.\-/]+(?: [\w+#.\-/]+){0,2}),? (?:and|or) "
    r"([\w+#.\-/]+(?: [\w+#.\-/]+){0,2})\b",
    re.IGNORECASE,
)

_CONTRAST_RE = re.compile(
    r"\b(?:not (?:just |only |merely |simply )?[^.;,]{1,60}?,? but\b|isn't just\b|wasn't just\b"
    r"|aren't just\b|more than just\b|rather than\b)",
    re.IGNORECASE,
)

# Stats measured against your own earlier work, which a reader can't judge.
_SELF_COMPARISON_RE = re.compile(
    r"\b(?:than (?:my|our|the team's) (?:previous|prior|earlier|old|original|first|last)"
    r"|compared (?:to|with) (?:my|our) (?:previous|prior|earlier|old|own|first)"
    r"|(?:my|our) own [a-z ]{0,30}by \d+"
    r"|(?:faster|better|slower|more|fewer|less) than (?:I|we) (?:did|could|had)"
    r"|than (?:before|last (?:time|year|semester)))\b",
    re.IGNORECASE,
)

_AI_RE = re.compile(
    r"\b(AI|A\.I\.|LLMs?|Claude|ChatGPT|GPT-?\d*|Copilot|Gemini|Codex|Kiro|generative"
    r"|machine[- ]generated|AI-generated|language models?)\b",
    re.IGNORECASE,
)

_NUMBER_RE = re.compile(r"(?:~|\$)?\d[\d,]*(?:\.\d+)?(?:%|x|k|K|M|B|\+|ms|s|h)?")

# Words that can't tell the reader what a number counts.
_WEAK_AFTER = {
    "", "and", "or", "the", "a", "an", "to", "of", "in", "on", "for", "with", "by", "at", "from",
    "as", "so", "that", "which", "while", "times", "fold",
}

# Words after "N times" that make it a rate or a ratio, as in "10 times per second".
_TIMES_FOLLOWERS = {
    "per", "a", "an", "each", "faster", "slower", "more", "fewer", "less", "as", "higher", "lower",
}


def _normalize(s: str) -> str:
    return " ".join(s.lower().split())


def _ai_terms(text: str) -> list[str]:
    return [m.group(0).lower() for m in _AI_RE.finditer(text)]


def _first_word(text: str) -> str:
    """The first word of ``text`` after any spaces or hyphens, lowercased."""
    text = text.lstrip(" -")
    end = 0
    while end < len(text) and (text[end].isalnum() or text[end] == "'"):
        end += 1
    return text[:end].lower()


def _second_word(text: str) -> str | None:
    words = text.split()
    return words[1] if len(words) > 1 else None


def _unclear_number(new_text: str) -> Violation | None:
    """The first number that has no unit or noun after it, such as "improved it by 3"."""
    for m in _NUMBER_RE.finditer(new_text):
        token = m.group(0)
        if token.endswith(("%", "x", "s", "h")) or token.startswith("$"):
            continue  # has a unit ("ms" ends with "s")
        digits = "".join(c for c in token if c.isdigit())
        if len(digits) == 4 and digits.startswith(("19", "20")):
            continue  # a year
        after = new_text[m.end() :]
        before = new_text[: m.start()].rstrip().lower()
        next_word = _first_word(after)
        word_after_next = _second_word(after)

        # "from 12,000 to 3,000 per day" and "2 of 5 teams" are fine: the noun comes later.
        starts_range = (
            next_word in ("to", "of", "and", "or")
            and word_after_next is not None
            and word_after_next.lstrip("~$")[:1].isdigit()
        )
        ends_range = (
            (before.endswith(" to") and "from " in before)
            or before.endswith((" of", " and", " or"))
        )
        # "10 times per second" and "3 times faster" carry their unit in the next word.
        times_ok = (
            next_word == "times"
            and word_after_next is not None
            and re.sub(r"^\W+|\W+$", "", word_after_next.lower()) in _TIMES_FOLLOWERS
        )
        if next_word in _WEAK_AFTER and not starts_range and not ends_range and not times_ok:
            return Violation(
                rule=UNCLEAR_NUMBER,
                excerpt=token,
                message=f'"{token}" has no unit or noun after it, so the reader cannot tell what it counts.',
            )
    return None


def check_bullet(new_text: str, sources: list[str]) -> list[Violation]:
    """Check one rewritten bullet. ``sources`` are the texts it was rewritten from."""
    found: list[Violation] = []
    joined_sources = " \n ".join(_normalize(s) for s in sources)

    m = _DASH_RE.search(new_text)
    if m:
        found.append(
            Violation(
                rule=EM_DASH,
                excerpt=m.group(0).strip(),
                message="Use a comma, period or parentheses instead of a dash between clauses.",
            )
        )

    for m in _TRIAD_RE.finditer(new_text):
        if _normalize(m.group(0)) not in joined_sources:
            found.append(
                Violation(
                    rule=LIST_OF_THREE,
                    excerpt=m.group(0),
                    message="Three-item list added for rhythm. Keep the items that matter.",
                )
            )
            break

    m = _CONTRAST_RE.search(new_text)
    if m and _normalize(m.group(0)) not in joined_sources:
        found.append(
            Violation(
                rule=NOT_X_BUT_Y,
                excerpt=m.group(0),
                message="State what you did directly instead of contrasting it with what you did not do.",
            )
        )

    for m in _STOCK_RE.finditer(new_text):
        found.append(
            Violation(
                rule=STOCK_WORD,
                excerpt=m.group(0),
                message=f'"{m.group(0)}" is a stock word. Say what actually happened.',
            )
        )

    m = _SELF_COMPARISON_RE.search(new_text)
    if m:
        found.append(
            Violation(
                rule=SELF_COMPARISON,
                excerpt=m.group(0),
                message="Compares the work to your own earlier work. Use an absolute number or drop it.",
            )
        )

    source_ai = {term for s in sources for term in _ai_terms(s)}
    new_ai = next((t for t in _ai_terms(new_text) if t not in source_ai), None)
    if new_ai:
        found.append(
            Violation(
                rule=AI_MENTION,
                excerpt=new_ai,
                message="Mentions AI tooling that the source bullet does not mention.",
            )
        )

    unclear = _unclear_number(new_text)
    if unclear:
        found.append(unclear)
    return found


_SUMMARY_WORDS = ["summary", "objective", "profile", "about me", "professional overview"]


def is_summary_section(title: str) -> bool:
    """True for a section title that would add a summary, objective or profile.

    The template engine already locks section order. This also catches model
    suggestions that ask for one, so they can be dropped.
    """
    t = title.lower()
    return any(w in t for w in _SUMMARY_WORDS)
