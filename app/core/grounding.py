"""Grounding check for rewritten bullets.

Every number, proper noun and skill in a rewrite has to appear in the sources it
cites: the original bullets, facts-bank entries, and the heading of the role or
project the bullet sits under. Anything else is blocked and the reason is shown.
Small numbers get no exception, because "5 components" is as checkable a claim
as "5,000 users".
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from pydantic import BaseModel

from app.core.skills import lexicon

NUMBER = "number"
PROPER_NOUN = "proper_noun"
SKILL = "skill"

_KIND_LABELS = {NUMBER: "Number", PROPER_NOUN: "Name", SKILL: "Skill"}


class Claim(BaseModel):
    text: str
    kind: str
    supported: bool


class Source(BaseModel):
    # A bullet id ("b3"), a fact id ("f2"), or "heading".
    id: str
    text: str


class GroundingReport(BaseModel):
    claims: list[Claim] = []
    # Problems with the citations themselves, such as citing nothing.
    citation_errors: list[str] = []

    def ok(self) -> bool:
        return not self.citation_errors and all(c.supported for c in self.claims)

    def unsupported(self) -> list[Claim]:
        return [c for c in self.claims if not c.supported]

    def reasons(self) -> list[str]:
        """One line per problem, for the UI."""
        lines = list(self.citation_errors)
        for c in self.unsupported():
            lines.append(f'{_KIND_LABELS[c.kind]} "{c.text}" is not in the cited sources.')
        return lines


# ---------------------------------------------------------------------------
# Numbers
# ---------------------------------------------------------------------------

# A number written with digits, and an optional unit that changes its value.
_DIGITS_RE = re.compile(
    r"\b(\d[\d,]*(?:\.\d+)?)\s?(%|percent\b|k\b|m\b|million\b|thousand\b|x\b|times\b|hundred\b|billion\b|b\b)?",
    re.IGNORECASE,
)

_WORD_NUMBER_RE = re.compile(
    r"\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|"
    r"fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|"
    r"ninety|hundred|thousand|million|dozen|double[sd]?|doubling|twice|triple[sd]?|tripling|half|"
    r"halved|halving|quadrupled)\b",
    re.IGNORECASE,
)

_WORD_VALUES = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20,
    "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
    "hundred": 100, "thousand": 1000, "million": 1_000_000, "dozen": 12,
}

_MULTIPLIERS = {
    "k": 1_000, "thousand": 1_000, "m": 1_000_000, "million": 1_000_000,
    "b": 1_000_000_000, "billion": 1_000_000_000, "hundred": 100,
}


@dataclass
class Num:
    value: float
    percent: bool = False
    # A ratio such as "2x", "twice" or "halved".
    ratio: bool = False


def _word_number(word: str) -> Num:
    w = word.lower()
    if w in ("half", "halved", "halving"):
        return Num(0.5, ratio=True)
    if w == "quadrupled":
        return Num(4, ratio=True)
    if w.startswith("doubl") or w == "twice":
        return Num(2, ratio=True)
    if w.startswith("tripl"):
        return Num(3, ratio=True)
    return Num(_WORD_VALUES[w])


def numbers(text: str) -> list[tuple[str, Num]]:
    """Every number in ``text``, as (the text as written, its value)."""
    found = []
    for m in _DIGITS_RE.finditer(text):
        try:
            value = float(m.group(1).rstrip(",").replace(",", ""))
        except ValueError:
            continue
        unit = (m.group(2) or "").lower()
        num = Num(value)
        if unit in ("%", "percent"):
            num.percent = True
        elif unit in ("x", "times"):
            num.ratio = True
        elif unit in _MULTIPLIERS:
            num.value *= _MULTIPLIERS[unit]
        found.append((m.group(0).strip(), num))
    for m in _WORD_NUMBER_RE.finditer(text):
        # "one" is too often a pronoun ("the one that...") to treat as a claim.
        if m.group(0).lower() == "one":
            continue
        found.append((m.group(0), _word_number(m.group(0))))
    return found


def number_supported(n: Num, source_numbers: list[Num]) -> bool:
    """A number needs the same value in a source. A percent or ratio needs one of the same kind.

    So "75% fewer calls" isn't backed by "12,000 to 3,000", even though the math
    works out: the reader can't check a number the resume never states.
    """
    return any(
        abs(s.value - n.value) < 1e-9 and (not n.percent or s.percent) and (not n.ratio or s.ratio)
        for s in source_numbers
    )


# ---------------------------------------------------------------------------
# Proper nouns
# ---------------------------------------------------------------------------

# Capitalized words that are ordinary at the start of a clause or in titles.
_COMMON_CAPS = {
    "I", "A", "An", "The", "And", "Or", "But", "For", "With", "To", "In", "On", "Of", "As", "By",
    "At", "From", "Into", "So", "Then", "This", "That", "Each", "All",
}


def tokens(text: str) -> list[tuple[int, str]]:
    """Words in ``text`` with their start positions.

    Letters, digits and ``' . + # &`` are part of a word, so "Node.js", "C++"
    and "R&D" stay whole. A trailing period, quote or "'s" is dropped.
    """
    found = []
    start = None
    for i, ch in enumerate(text + " "):
        part_of_word = ch.isalnum() or ch in "'.+#&"
        if part_of_word and start is None:
            start = i
        elif not part_of_word and start is not None:
            found.append((start, text[start:i]))
            start = None
    out = []
    for start, word in found:
        word = word.rstrip(".'")
        word = word.removesuffix("'s")
        if word:
            out.append((start, word))
    return out


def looks_proper(word: str) -> bool:
    if not word[0].isupper():
        # Mixed-case words such as "iPhone" or "macOS".
        return any(c.isupper() for c in word[1:]) and any(c.islower() for c in word)
    return word not in _COMMON_CAPS


def is_sentence_start(text: str, offset: int) -> bool:
    before = text[:offset].rstrip()
    return not before or before.endswith((".", ":", ";", "!", "?", "(", '"', "“"))


def strongly_proper(word: str) -> bool:
    """True for words that are capitalized wherever they appear.

    That means all caps (AWS), capitals inside the word (GitHub), or letters
    mixed with digits (S3). Those count as names even at the start of a sentence.
    """
    letters = [c for c in word if c.isalpha()]
    return (
        (len(letters) >= 2 and all(c.isupper() for c in letters))
        or any(c.isupper() for c in word[1:])
        or (any(c.isdigit() for c in word) and bool(letters))
    )


def proper_nouns(text: str) -> list[str]:
    found: list[str] = []
    for offset, word in tokens(text):
        if not looks_proper(word) or all(c.isdigit() or c in ".," for c in word):
            continue
        if is_sentence_start(text, offset) and not strongly_proper(word):
            continue  # "Built" or "Cut" at the start of a bullet
        if word not in found:
            found.append(word)
    return found


def _word_in(text_lower: str, word: str) -> bool:
    w = word.lower()
    return any(t == w for _, t in tokens(text_lower))


# ---------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------


def check(new_text: str, sources: list[Source]) -> GroundingReport:
    """Check a rewritten bullet against the sources it cites."""
    report = GroundingReport()
    if not any(s.id != "heading" for s in sources):
        report.citation_errors.append("The rewrite does not cite an original bullet or fact.")

    joined = "\n".join(s.text for s in sources)
    joined_lower = joined.lower()
    source_numbers = [n for _, n in numbers(joined)]
    lex = lexicon()

    for text, n in numbers(new_text):
        report.claims.append(Claim(text=text, kind=NUMBER, supported=number_supported(n, source_numbers)))

    skills = lex.find(new_text)
    for skill in skills:
        # Aliases count, so "Golang" in the rewrite is backed by "Go" in the source.
        report.claims.append(Claim(text=skill, kind=SKILL, supported=lex.contains(joined, skill)))

    for noun in proper_nouns(new_text):
        # Skills were already checked above, with their aliases.
        if any(s.lower() == noun.lower() for s in skills) or any(s in skills for s in lex.find(noun)):
            continue
        # "AWS's" or "R&D" can be backed by their parts.
        parts = [p for p in re.split(r"[.&']", noun) if p]
        supported = _word_in(joined_lower, noun) or (bool(parts) and all(_word_in(joined_lower, p) for p in parts))
        report.claims.append(Claim(text=noun, kind=PROPER_NOUN, supported=supported))
    return report
