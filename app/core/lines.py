"""Every line of the resume the rewrite step can address, and which parts of it are facts.

A line is one slot of the template: a bullet, a skills line, or one field of
a role, school or project heading. Each line is one of two kinds:

- Editable prose: bullets, the coursework list, skills lists, a project's
  tech stack after the "|", and the wording of an honor. The model may
  rewrite or reorder these on its own, and the grounding check still applies.
- Protected facts: dates, GPA, school, degree, employer, job title, location,
  an honor's name and its numbers (applicants, awards, amounts). The model
  never changes these on its own. Only the person can, by asking for it in
  "Anything to add?" (see ``instructions.py``).

``protected`` lists the exact pieces of a line that must survive a rewrite
the person didn't ask for. A line that is a fact through and through (a date,
an employer) has its whole text there and isn't sent to the model at all.
"""

from __future__ import annotations

import re

from pydantic import BaseModel

from app.core.bold import strip_bold
from app.core.tex import BULLET, PROJECT_HEADING, SKILLS_LINE, SUBHEADING, TexDoc, tex_to_plain

# Line kinds.
BULLET_LINE = "bullet"
COURSEWORK = "coursework"
SKILLS = "skills"
HONOR = "honor"
STACK = "stack"  # a project heading: name | tech stack
NAME = "name"  # school or employer
SUBTITLE = "subtitle"  # degree line or job title
DATE = "date"
PLACE = "place"

_MONTH = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?"
_SEASON = r"(?:Spring|Summer|Fall|Autumn|Winter)"
DATE_RE = re.compile(rf"\b(?:{_MONTH}|{_SEASON})\s+(?:19|20)\d{{2}}\b|\b(?:19|20)\d{{2}}\b", re.IGNORECASE)
GPA_RE = re.compile(r"\bGPA\b:?\s*\d(?:\.\d+)?(?:\s*/\s*\d(?:\.\d+)?)?", re.IGNORECASE)
NUMBER_RE = re.compile(r"[~$]?\d[\d,]*(?:\.\d+)?\+?%?")
_DATE_WORDS = re.compile(r"\b(present|current|expected|now)\b", re.IGNORECASE)


class Line(BaseModel):
    id: str
    kind: str
    section: str
    # Where the line sits, for the card and the prompt: "Projects | TrailMap", "Education | State University".
    heading: str
    # What the line is, in a few words: "Graduation date", "Tech stack", "Job title".
    label: str
    text: str
    # Whether the model may change it on its own.
    editable: bool
    # Exact pieces that must survive a change the person didn't ask for.
    protected: list[str] = []
    # The role, school or project the line belongs to, when it has one.
    entry: int | None = None


def plain(text: str) -> str:
    """A line's text for comparing: no bold or italic marks, single spaces."""
    return " ".join(strip_bold(text).replace("*", "").split())


def looks_like_date(text: str) -> bool:
    return bool(DATE_RE.search(text) or _DATE_WORDS.search(text))


def _unique(items: list[str]) -> list[str]:
    out: list[str] = []
    for item in items:
        item = item.strip()
        if item and item not in out:
            out.append(item)
    return out


def _dates_and_gpa(text: str) -> list[str]:
    return [m.group(0) for m in GPA_RE.finditer(text)] + [m.group(0) for m in DATE_RE.finditer(text)]


def _honor_name(text: str) -> str:
    """An honor's name: its bold part, or the part before " | "."""
    bold = re.search(r"\*\*(.+?)\*\*", text)
    if bold:
        return plain(bold.group(1))
    return plain(text.split(" | ")[0]) if " | " in text else ""


def _is_honors(section: str, label: str = "") -> bool:
    words = f"{section} {label}".lower()
    return "honor" in words or "award" in words or "scholarship" in words


def _skills_label(doc: TexDoc, slot_id: str) -> str:
    slot = doc.slot(slot_id)
    label = (slot.label or "") if slot else ""
    return tex_to_plain(label) or label


def _entry_name(doc: TexDoc, entry: int | None) -> str:
    if entry is None:
        return ""
    fields = doc.entries[entry].fields
    return plain(doc.text(fields[0]) or "").split(" | ")[0] if fields else ""


def resume_lines(doc: TexDoc) -> list[Line]:
    """Every line the rewrite can address, in the order of the page."""
    out: list[Line] = []
    for slot in doc.slots:
        text = doc.text(slot.id) or ""
        section = slot.section
        name = _entry_name(doc, slot.entry)
        where = f"{section} | {name}" if name else section

        if slot.kind == BULLET:
            if _is_honors(section):
                protected = [_honor_name(text)] + [m.group(0) for m in NUMBER_RE.finditer(plain(text))]
                out.append(Line(id=slot.id, kind=HONOR, section=section, heading=section, label="Honor",
                                text=text, editable=True, protected=_unique(protected), entry=slot.entry))
            elif "coursework" in text.lower():
                label = re.match(r"\*\*(.+?)\*\*", text)
                protected = [plain(label.group(1))] if label else []
                out.append(Line(id=slot.id, kind=COURSEWORK, section=section, heading=where, label="Coursework",
                                text=text, editable=True, protected=protected, entry=slot.entry))
            else:
                protected = _dates_and_gpa(plain(text))
                if "education" in section.lower():
                    protected += [m.group(0) for m in NUMBER_RE.finditer(plain(text))]
                out.append(Line(id=slot.id, kind=BULLET_LINE, section=section, heading=where, label="Bullet",
                                text=text, editable=True, protected=_unique(protected), entry=slot.entry))

        elif slot.kind == SKILLS_LINE:
            label = _skills_label(doc, slot.id)
            if _is_honors(section, label):
                protected = [m.group(0) for m in NUMBER_RE.finditer(plain(text))]
                out.append(Line(id=slot.id, kind=HONOR, section=section, heading=f"{section} | {label}",
                                label=label, text=text, editable=True, protected=_unique(protected)))
            else:
                out.append(Line(id=slot.id, kind=SKILLS, section=section, heading=f"{section} | {label}",
                                label=label, text=text, editable=True))

        elif slot.kind == PROJECT_HEADING:
            if slot.arg == 0:
                project = plain(text).split(" | ")[0]
                has_stack = " | " in plain(text)
                out.append(Line(id=slot.id, kind=STACK if has_stack else NAME, section=section,
                                heading=f"{section} | {project}", label="Tech stack" if has_stack else "Project name",
                                text=text, editable=has_stack, protected=[project] if has_stack else [plain(text)],
                                entry=slot.entry))
            else:
                out.append(Line(id=slot.id, kind=DATE, section=section, heading=where, label="Dates",
                                text=text, editable=False, protected=[plain(text)], entry=slot.entry))

        elif slot.kind == SUBHEADING:
            school = "education" in section.lower()
            if slot.arg == 0:
                kind, label = NAME, "School" if school else "Employer"
            elif slot.arg == 2:
                kind, label = SUBTITLE, "Degree line" if school else "Job title"
            elif looks_like_date(text):
                kind, label = DATE, "Graduation date" if school else "Dates"
            else:
                kind, label = PLACE, "Location"
            out.append(Line(id=slot.id, kind=kind, section=section, heading=where, label=label, text=text,
                            editable=False, protected=[plain(text)] if text.strip() else [], entry=slot.entry))
    return out


def protected_changes(line: Line, new_text: str) -> list[str]:
    """The protected pieces of a line that ``new_text`` no longer has, word for word."""
    new = plain(new_text).lower()
    return [p for p in line.protected if plain(p).lower() not in new]
