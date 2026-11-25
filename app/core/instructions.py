"""Changes the person asks for in "Anything to add?", applied by the app itself.

A note such as "change graduation date to 2027" is an instruction, not a fact.
The person is the source, so it may change a protected fact (a date, a GPA, a
degree) that the model may never touch on its own. The app applies it in code,
literally, to the one line it names:

- "change graduation date to 2027" changes the year of the Education date.
- "change GPA to 3.5" changes the number after GPA.
- "change Data Structures to Data Structures and Algorithms" changes that text
  on the one line that has it.
- "add Compilers to coursework" or "add Docker to the TrailMap stack" adds an
  item to the end of that list.

Only what the note names changes. When a note could mean more than one line
("fix my dates"), or doesn't say what the new text is, nothing is changed and
the person is asked which line and what it should say.
"""

from __future__ import annotations

import re

from pydantic import BaseModel

from app.core.lines import COURSEWORK, DATE, GPA_RE, NAME, PLACE, SKILLS, STACK, SUBTITLE, Line, plain
from app.core.tex import split_skills

CHANGE = "change"
ADD = "add"
ASK = "ask"  # the note could mean more than one line, or doesn't say what to write
NOT_FOUND = "not_found"  # nothing on the resume matches what the note names

_CHANGE_RE = re.compile(
    r"^(?:please\s+)?(?P<verb>change|update|set|make|correct|fix|edit|replace|switch|rename)\s+(?P<target>.+?)"
    r"(?:\s+(?:to|with|into|as|=)\s+(?P<value>.+?))?$",
    re.IGNORECASE,
)
_ADD_RE = re.compile(
    r"^(?:please\s+)?(?:add|include|put|list)\s+(?P<value>.+?)\s+(?:to|in|into|under|on)\s+(?P<target>.+)$",
    re.IGNORECASE,
)
# Verbs that also start ordinary facts ("Set up 20 laptops", "Made a Discord bot").
_WEAK_VERBS = {"set", "make", "fix"}
_FILLER = re.compile(r"\b(my|the|a|an|on|in|of|for|line|section|resume|please)\b", re.IGNORECASE)
_YEAR = re.compile(r"\b(?:19|20)\d{2}\b")
_MONTH_YEAR = re.compile(
    r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(?:19|20)\d{2}\b", re.IGNORECASE
)
# A note that only adds a skill to "skills" is left to the rewrite, which picks the line it fits.
_GENERIC_SKILLS = re.compile(r"^(?:technical\s+)?skills?(?:\s+section)?$", re.IGNORECASE)


class Instruction(BaseModel):
    """One change asked for in a note, and what the app made of it."""

    id: str
    note: str
    # CHANGE or ADD when it resolved to one line; ASK or NOT_FOUND when it didn't.
    kind: str
    target: str = ""
    value: str = ""
    line_id: str = ""
    old_text: str = ""
    new_text: str = ""
    # For ASK and NOT_FOUND: what the person is told, in a sentence.
    question: str = ""
    # For ASK: the lines it could mean.
    candidates: list[str] = []


def _words(text: str) -> str:
    return " ".join(_FILLER.sub(" ", text.lower()).replace("'s", "").split())


def _clean(value: str) -> str:
    return value.strip().strip("\"'“”").rstrip(".").strip()


def _describe(line: Line) -> str:
    return f'{line.label} ({line.heading}): "{plain(line.text)}"'


def _named_entry(lines: list[Line], target: str) -> list[Line]:
    """Lines of the role, school or project whose name the target mentions."""
    t = target.lower()
    names = {ln.entry: plain(ln.text).split(" | ")[0] for ln in lines if ln.kind in (NAME, STACK) and ln.entry is not None}
    said = set(_words(target).split())
    common = {"university", "college", "school", "public", "inc", "team", "and", "state", "project"}
    hits = {
        e
        for e, name in names.items()
        if name and (name.lower() in t or any(w in said for w in _words(name).split() if len(w) > 2 and w not in common))
    }
    return [ln for ln in lines if ln.entry in hits]


def _by_meaning(lines: list[Line], target: str) -> tuple[list[Line], bool]:
    """Lines a target names by what they are ("graduation date", "GPA"). The flag says whether it named a kind at all."""
    t = _words(target)
    scoped = _named_entry(lines, target) or lines
    education = [ln for ln in scoped if "education" in ln.section.lower()]
    if re.search(r"\bgpa\b", t):
        return [ln for ln in scoped if GPA_RE.search(plain(ln.text))], True
    if re.search(r"\b(graduation|grad|expected)\b", t):
        return [ln for ln in education if ln.kind == DATE], True
    if re.search(r"\b(degree|major|minor)\b", t):
        return [ln for ln in education if ln.kind == SUBTITLE], True
    if re.search(r"\b(school|university|college)\b", t):
        return [ln for ln in education if ln.kind == NAME], True
    if re.search(r"\bcoursework|courses\b", t):
        return [ln for ln in scoped if ln.kind == COURSEWORK], True
    if re.search(r"\b(stack|tech|technologies)\b", t):
        return [ln for ln in scoped if ln.kind == STACK], True
    if re.search(r"\b(title|role|position)\b", t):
        return [ln for ln in scoped if ln.kind == SUBTITLE and "education" not in ln.section.lower()], True
    if re.search(r"\b(location|city|place)\b", t):
        return [ln for ln in scoped if ln.kind == PLACE], True
    if re.search(r"\bdates?\b", t):
        return [ln for ln in scoped if ln.kind == DATE], True
    if re.search(r"\bskills?\b", t):
        named = [ln for ln in lines if ln.kind == SKILLS and _words(ln.label) and _words(ln.label) in t]
        return named or [ln for ln in lines if ln.kind == SKILLS], True
    named = [ln for ln in lines if ln.kind == SKILLS and _words(ln.label) and _words(ln.label) == t]
    return named, bool(named)


def _replace_date(old: str, value: str) -> str:
    """A new date in a date field, changing only what the value gives: the year, or the month and year."""
    if _YEAR.fullmatch(value) and len(_YEAR.findall(old)) == 1:
        return _YEAR.sub(value, old)
    if _MONTH_YEAR.fullmatch(value) and len(_MONTH_YEAR.findall(old)) == 1:
        return _MONTH_YEAR.sub(value, old)
    return value


def _apply_meaning(line: Line, target: str, value: str) -> str:
    old = line.text
    if re.search(r"\bgpa\b", target, re.IGNORECASE):
        return re.sub(r"(\bGPA\b:?\s*)\d(?:\.\d+)?", lambda m: m.group(1) + value, old, count=1, flags=re.IGNORECASE)
    if line.kind == DATE:
        return _replace_date(old, value)
    if line.kind == SUBTITLE and " | " in old and re.search(r"\b(degree|major)\b", target, re.IGNORECASE):
        # The degree is the first part of "Degree | Minor | GPA"; the rest stays.
        return value + old[old.index(" | "):]
    if line.kind == STACK and " | " in old:
        head = old[: old.index(" | ")]
        return f"{head} | *{value.strip('*')}*"
    return value


def _ask(iid: str, note: str, target: str, value: str, options: list[Line], what: str) -> Instruction:
    listed = "; ".join(_describe(ln) for ln in options[:6])
    return Instruction(
        id=iid, note=note, kind=ASK, target=target, value=value, candidates=[ln.id for ln in options],
        question=f'"{note}" could mean more than one line. {what} It could be: {listed}.',
    )


def _change(iid: str, note: str, verb: str, target: str, value: str, lines: list[Line]) -> Instruction | None:
    target = _clean(target)
    value = _clean(value)
    matches, named_kind = _by_meaning(lines, target)
    literal = False
    if not named_kind:
        # Text the note quotes from the resume: the one line that has it.
        needle = plain(target).lower()
        matches = [ln for ln in lines if needle and needle in plain(ln.text).lower()]
        literal = True
    if literal and verb.lower() in _WEAK_VERBS and (not matches or not value):
        # "Set up 20 laptops for a club" is a fact that starts like an instruction.
        return None
    if not matches:
        what = "Nothing on your resume matches it" if literal else f'There\'s no "{target}" on your resume'
        return Instruction(id=iid, note=note, kind=NOT_FOUND, target=target, value=value,
                           question=f'"{note}": {what}, so nothing was changed. Name the line, or quote its text.')
    if len(matches) > 1:
        return _ask(iid, note, target, value, matches, "Say which one, and what it should say.")
    line = matches[0]
    if not value:
        return _ask(iid, note, target, value, matches, f"It doesn't say what the {line.label.lower()} should say.")
    if literal:
        needle = plain(target).lower()
        # Replace in the text as written when the words are there as one piece, so bold stays.
        base = line.text if needle in line.text.lower() else plain(line.text)
        start = base.lower().index(needle)
        new_text = base[:start] + value + base[start + len(needle):]
    else:
        new_text = _apply_meaning(line, target, value)
    return Instruction(id=iid, note=note, kind=CHANGE, target=target, value=value, line_id=line.id,
                       old_text=line.text, new_text=new_text)


def _add(iid: str, note: str, target: str, value: str, lines: list[Line]) -> Instruction | None:
    target = _clean(target)
    value = _clean(value)
    if _GENERIC_SKILLS.match(target.replace("my ", "").replace("the ", "").strip()):
        return None
    matches, named_kind = _by_meaning(lines, target)
    matches = [ln for ln in matches if ln.kind in (COURSEWORK, STACK, SKILLS)]
    if not named_kind or len(matches) != 1:
        # Not one list line: leave the note as a fact for the rewrite to place.
        return None
    line = matches[0]
    if line.kind == STACK:
        head, stack = line.text.split(" | ", 1)
        items = split_skills(stack.strip("*"))
        new_text = f"{head} | *{', '.join(items + [value])}*"
    else:
        new_text = f"{line.text.rstrip().rstrip(',')}, {value}"
    return Instruction(id=iid, note=note, kind=ADD, target=target, value=value, line_id=line.id,
                       old_text=line.text, new_text=new_text)


def parse_instruction(iid: str, note: str, lines: list[Line]) -> Instruction | None:
    """The change a note asks for, or None when the note is a fact."""
    text = " ".join(note.split()).rstrip(".")
    m = _ADD_RE.match(text)
    if m:
        return _add(iid, text, m.group("target"), m.group("value"), lines)
    m = _CHANGE_RE.match(text)
    if m:
        return _change(iid, text, m.group("verb"), m.group("target"), m.group("value") or "", lines)
    return None
