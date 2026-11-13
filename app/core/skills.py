"""Keyword coverage, counted in code.

Skills are found with a fixed list (``skills.txt``) and whole-word matching, so
the same posting and resume always give the same numbers. The model's match
score is shown next to these numbers as an opinion; these are the steady ones.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache
from pathlib import Path

from pydantic import BaseModel

LEXICON_FILE = Path(__file__).parent / "skills.txt"

REQUIRED = "required"
PREFERRED = "preferred"
MENTIONED = "mentioned"


def normalize(s: str, keep_case: bool = False) -> str:
    """Lowercase (unless ``keep_case``) and turn hyphens and runs of spaces into one space."""
    out = []
    last_space = True
    for ch in s:
        if ch in "-–" or ch.isspace():
            if not last_space:
                out.append(" ")
            last_space = True
        else:
            out.append(ch if keep_case else ch.lower())
            last_space = False
    return "".join(out).rstrip()


def is_token_char(c: str) -> bool:
    return c.isalnum() or c in "+#"


def contains_token(hay: str, needle: str) -> bool:
    """Find ``needle`` in ``hay`` as a whole word.

    It can't be glued to letters, digits, ``+`` or ``#`` on either side, and it
    can't be followed by ``.word``, so ``Node`` doesn't match inside ``Node.js``
    and ``C`` doesn't match inside ``C++``. One-letter names also need list
    context (see ``single_letter_context``).
    """
    if not needle:
        return False
    start_from = 0
    while True:
        s = hay.find(needle, start_from)
        if s == -1:
            return False
        e = s + len(needle)
        before = hay[s - 1] if s > 0 else None
        after = hay[e] if e < len(hay) else None
        after2 = hay[e + 1] if e + 1 < len(hay) else None
        left_ok = before is None or (not is_token_char(before) and before != ".")
        right_ok = (after is None or not is_token_char(after)) and not (
            after == "." and after2 is not None and after2.isalnum()
        )
        if left_ok and right_ok and (len(needle) > 1 or single_letter_context(hay, s, e)):
            return True
        start_from = s + 1


def single_letter_context(hay: str, s: int, e: int) -> bool:
    """True when a one-letter name such as C or R sits in a list or after "in"/"with".

    Without this, "Series C startup" would count as knowing C.
    """
    if hay[e : e + 1] in ("&", "'"):
        return False  # "R&D", "C's"
    next_char = hay[e:].lstrip()[:1]
    prev_char = hay[:s].rstrip()[-1:]
    words_before = hay[:s].split()
    prev_word = words_before[-1].lower() if words_before else ""
    return (
        prev_char in (",", "/", ":", "(")
        or next_char in (",", "/", ")")
        or prev_word in ("and", "or", "in", "with", "using")
    )


@dataclass
class _Pattern:
    text: str
    case_sensitive: bool


@dataclass
class SkillEntry:
    canonical: str
    patterns: list[_Pattern]


class Lexicon:
    def __init__(self, entries: list[SkillEntry]):
        self.entries = entries

    @classmethod
    def parse(cls, raw: str) -> Lexicon:
        """Read the lexicon format: ``Canonical | alias | alias``, ``=`` for case-sensitive."""
        entries = []
        for line in raw.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            names = [n.strip() for n in line.split("|") if n.strip()]
            patterns = []
            for name in names:
                case_sensitive = name.startswith("=")
                bare = name.lstrip("=")
                patterns.append(_Pattern(normalize(bare, case_sensitive), case_sensitive))
            entries.append(SkillEntry(canonical=names[0].lstrip("="), patterns=patterns))
        return cls(entries)

    @staticmethod
    def _matches(entry: SkillEntry, lower: str, cased: str) -> bool:
        return any(contains_token(cased if p.case_sensitive else lower, p.text) for p in entry.patterns)

    def find(self, text: str) -> list[str]:
        """Canonical names of every skill in ``text``, in lexicon order."""
        lower = normalize(text)
        cased = normalize(text, keep_case=True)
        return [e.canonical for e in self.entries if self._matches(e, lower, cased)]

    def contains(self, text: str, canonical: str) -> bool:
        """True when ``text`` mentions the skill under any of its names."""
        entry = next((e for e in self.entries if e.canonical.lower() == canonical.lower()), None)
        if entry is None:
            return False
        return self._matches(entry, normalize(text), normalize(text, keep_case=True))


@cache
def lexicon() -> Lexicon:
    return Lexicon.parse(LEXICON_FILE.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Skills in a posting
# ---------------------------------------------------------------------------


class PostingSkills(BaseModel):
    required: list[str] = []
    preferred: list[str] = []
    mentioned: list[str] = []


# What a posting heading tells us about the lines under it.
_ZONE_REQUIRED = "required"
_ZONE_PREFERRED = "preferred"
_ZONE_NEUTRAL = "neutral"  # about the company, benefits, the role
_ZONE_OTHER = "other"  # before any heading we recognize

_PREFERRED_HEADINGS = [
    "preferred", "nice to have", "nice-to-have", "bonus", "desired", "pluses",
    "good to have", "extra credit", "ideal candidate",
]
_REQUIRED_HEADINGS = [
    "required", "requirement", "minimum qualifications", "basic qualifications", "qualifications",
    "what you need", "what you'll need", "you will need", "must have", "must-have", "who you are",
    "what we're looking for", "what we are looking for", "you have", "you bring", "skills",
]
_NEUTRAL_HEADINGS = [
    "about", "benefits", "perks", "compensation", "salary", "pay range", "equal opportunity",
    "what you'll do", "what you will do", "responsibilities", "the role", "the team", "why join",
    "how to apply", "location",
]
# Phrases that make a single line preferred, wherever it sits.
_INLINE_PREFERRED = ["a plus", "is a plus", "nice to have", "preferred", "bonus", "not required", "familiarity with"]


def heading_zone(line: str) -> str | None:
    """The zone a heading starts, or None if the line isn't a heading we know."""
    text = line.strip().rstrip(":").lower()
    if not text or len(text) > 70:
        return None
    # Preferred is checked first, so "Preferred qualifications" isn't read as required.
    if any(w in text for w in _PREFERRED_HEADINGS):
        return _ZONE_PREFERRED
    if any(w in text for w in _REQUIRED_HEADINGS):
        return _ZONE_REQUIRED
    if any(w in text for w in _NEUTRAL_HEADINGS):
        return _ZONE_NEUTRAL
    return None


def extract_posting_skills(posting: str) -> PostingSkills:
    """Split the skills in a posting into required, preferred and other mentions.

    A posting with no requirements heading has every skill counted as required.
    """
    lex = lexicon()
    zone = _ZONE_OTHER
    saw_required_heading = False
    required: set[str] = set()
    preferred: set[str] = set()
    other: set[str] = set()
    for line in posting.splitlines():
        looks_like_heading = len(line.strip()) <= 70 and not line.lstrip().startswith(("-", "*", "•"))
        if looks_like_heading:
            new_zone = heading_zone(line)
            if new_zone is not None:
                zone = new_zone
                saw_required_heading = saw_required_heading or new_zone == _ZONE_REQUIRED
                # No "continue": a heading line can list skills too, as in "Skills: Python, SQL".
        inline_preferred = any(w in line.lower() for w in _INLINE_PREFERRED)
        for skill in lex.find(line):
            if inline_preferred and zone != _ZONE_NEUTRAL:
                preferred.add(skill)
            elif zone == _ZONE_REQUIRED:
                required.add(skill)
            elif zone == _ZONE_PREFERRED:
                preferred.add(skill)
            else:
                other.add(skill)
    if not saw_required_heading:
        required |= other
        other = set()
    # A skill keeps its strongest tier.
    preferred -= required
    other -= required | preferred

    def in_lexicon_order(names: set[str]) -> list[str]:
        return [e.canonical for e in lex.entries if e.canonical in names]

    return PostingSkills(
        required=in_lexicon_order(required),
        preferred=in_lexicon_order(preferred),
        mentioned=in_lexicon_order(other),
    )


# ---------------------------------------------------------------------------
# Coverage
# ---------------------------------------------------------------------------


class SkillStatus(BaseModel):
    skill: str
    tier: str
    # The resume being scored shows it.
    covered: bool
    # The base resume or the facts bank shows it, so it's real experience.
    have: bool
    # You have it but the scored resume doesn't show it. These are the only
    # skills a rewrite may add.
    addable: bool
    # Where the evidence is: "base", or a facts-bank id such as "f2".
    evidence: str | None = None


class Coverage(BaseModel):
    skills: list[SkillStatus] = []
    required_total: int = 0
    required_have: int = 0
    required_covered: int = 0
    preferred_total: int = 0
    preferred_have: int = 0
    preferred_covered: int = 0

    def required_pct(self) -> float | None:
        """Share of the required skills you have that the resume shows. None if you have none."""
        return self.required_covered / self.required_have if self.required_have else None

    def preferred_pct(self) -> float | None:
        return self.preferred_covered / self.preferred_have if self.preferred_have else None


def coverage(posting: PostingSkills, resume_text: str, base_text: str, facts: list[tuple[str, str]]) -> Coverage:
    """Check each posting skill against the resume being scored.

    ``facts`` is a list of (id, text) pairs from the facts bank. A skill only
    counts as covered when it's real: the resume shows it *and* the base resume
    or a fact backs it up. Putting an invented skill on the page doesn't help.
    """
    lex = lexicon()
    cov = Coverage()
    for tier, names in ((REQUIRED, posting.required), (PREFERRED, posting.preferred), (MENTIONED, posting.mentioned)):
        for skill in names:
            if lex.contains(base_text, skill):
                evidence = "base"
            else:
                evidence = next((fid for fid, text in facts if lex.contains(text, skill)), None)
            have = evidence is not None
            covered = have and lex.contains(resume_text, skill)
            if tier == REQUIRED:
                cov.required_total += 1
                cov.required_have += have
                cov.required_covered += covered
            elif tier == PREFERRED:
                cov.preferred_total += 1
                cov.preferred_have += have
                cov.preferred_covered += covered
            cov.skills.append(
                SkillStatus(
                    skill=skill, tier=tier, covered=covered, have=have, addable=have and not covered, evidence=evidence
                )
            )
    return cov
