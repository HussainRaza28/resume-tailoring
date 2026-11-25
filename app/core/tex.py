"""Read and edit a resume written with the Jake's Resume LaTeX template.

The parser finds the *slots* in the document. A slot is a piece of text the app
is allowed to change:

* the argument of every ``\\resumeItem{...}`` (a bullet)
* each argument of ``\\resumeSubheading{..}{..}{..}{..}`` and
  ``\\resumeProjectHeading{..}{..}``
* the list after each ``\\textbf{Label}{: a, b, c}`` line in the skills section

Everything else (preamble, layout, header links, section order) is the
*skeleton*. ``verify_preserved`` checks that an edited file has exactly the
same skeleton, byte for byte.

Slot text goes to the models and the UI as plain text (``tex_to_plain``) and
comes back through ``plain_to_tex``, which escapes every special character.
That is why model output can never add a LaTeX command.

Positions are Python string indexes (characters), not bytes.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field

# Slot kinds. Heading slots also carry ``arg``, the argument number (0-based).
#   subheading: 0 company, 1 dates or place, 2 title, 3 place or dates
#   project_heading: 0 name and stack, 1 date
BULLET = "bullet"
SUBHEADING = "subheading"
PROJECT_HEADING = "project_heading"
SKILLS_LINE = "skills_line"


class Slot(BaseModel):
    id: str
    kind: str
    arg: int | None = None
    section: str
    # Index into TexDoc.entries for bullets and heading fields.
    entry: int | None = None
    # Label for skills lines, such as "Languages".
    label: str | None = None
    # Where the slot's text sits in the source.
    start: int
    end: int
    # Bullets only: the whole line holding \resumeItem{...}, used for removal.
    line: tuple[int, int] | None = Field(default=None, exclude=True)


class Entry(BaseModel):
    """A role or a project: one heading and the bullets under it."""

    index: int
    section: str
    kind: str
    fields: list[str] = []
    bullets: list[str] = []


# ---------------------------------------------------------------------------
# Edits
# ---------------------------------------------------------------------------


class SetText(BaseModel):
    """Replace a slot with plain text. It is escaped when written."""

    op: Literal["set_text"] = "set_text"
    slot: str
    text: str


class SetRaw(BaseModel):
    """Replace a slot with LaTeX the user typed. Braces must balance."""

    op: Literal["set_raw"] = "set_raw"
    slot: str
    tex: str


class Remove(BaseModel):
    """Remove a bullet's whole \\resumeItem{...} line."""

    op: Literal["remove"] = "remove"
    slot: str


class ReorderSkills(BaseModel):
    """Reorder a skills line. It must hold exactly the same skills."""

    op: Literal["reorder_skills"] = "reorder_skills"
    slot: str
    items: list[str]


Edit = Annotated[Union[SetText, SetRaw, Remove, ReorderSkills], Field(discriminator="op")]


def read_tex(path: Path | str) -> str:
    """Read a .tex file exactly as it is.

    ``newline=""`` keeps Windows line endings (CRLF) instead of turning them
    into ``\n``, so a file that goes in unchanged comes out byte for byte.
    """
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class TexError(Exception):
    """Base class for every template error. ``code`` is a short name for the UI."""

    code = "tex_error"


class NoDocument(TexError):
    code = "no_document"

    def __init__(self) -> None:
        super().__init__("no \\begin{document} found")


class Unbalanced(TexError):
    code = "unbalanced"

    def __init__(self, at: int) -> None:
        super().__init__(f"unbalanced braces after position {at}")


class UnknownSlot(TexError):
    code = "unknown_slot"

    def __init__(self, slot: str) -> None:
        self.slot = slot
        super().__init__(f"unknown slot {slot}")


class WrongKind(TexError):
    code = "wrong_kind"

    def __init__(self, slot: str) -> None:
        self.slot = slot
        super().__init__(f"slot {slot} cannot be changed that way")


class SkillsMismatch(TexError):
    code = "skills_mismatch"

    def __init__(self, slot: str) -> None:
        self.slot = slot
        super().__init__(f"skills reorder for {slot} must use exactly the listed skills")


class BadRaw(TexError):
    code = "bad_raw"

    def __init__(self, slot: str) -> None:
        self.slot = slot
        super().__init__(f"edited text for {slot} has unbalanced braces")


class ForbiddenCommand(TexError):
    code = "forbidden_command"

    def __init__(self, slot: str, command: str) -> None:
        self.slot = slot
        self.command = command
        super().__init__(
            f"edited text for {slot} uses \\{command}, which is not allowed inside a bullet or heading"
        )


class SkeletonChanged(TexError):
    code = "skeleton_changed"

    def __init__(self, detail: str) -> None:
        super().__init__(f"the template outside the editable text changed: {detail}")


# ---------------------------------------------------------------------------
# Scanning helpers
# ---------------------------------------------------------------------------


def is_escaped(s: str, i: int) -> bool:
    """True when the character at ``i`` follows an odd number of backslashes."""
    count = 0
    j = i
    while j > 0 and s[j - 1] == "\\":
        count += 1
        j -= 1
    return count % 2 == 1


def match_brace(s: str, open_at: int) -> int:
    """Given the index of a ``{``, return the index of its matching ``}``.

    A ``%`` that is not escaped starts a comment, so braces after it on the
    same line are ignored, the way TeX does.
    """
    depth = 0
    i = open_at
    while i < len(s):
        c = s[i]
        if c == "%" and not is_escaped(s, i):
            while i < len(s) and s[i] != "\n":
                i += 1
            continue
        if c == "{" and not is_escaped(s, i):
            depth += 1
        elif c == "}" and not is_escaped(s, i):
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise Unbalanced(open_at)


def skip_spaces(s: str, i: int) -> int:
    while i < len(s) and s[i].isspace():
        i += 1
    return i


def read_args(s: str, i: int, count: int) -> tuple[list[tuple[int, int]], int]:
    """Read ``count`` brace groups starting at ``i``. Spaces between them are fine.

    Returns the (start, end) of each group's content and the index after the last group.
    """
    ranges = []
    for _ in range(count):
        i = skip_spaces(s, i)
        if i >= len(s) or s[i] != "{":
            raise Unbalanced(i)
        close = match_brace(s, i)
        ranges.append((i + 1, close))
        i = close + 1
    return ranges, i


def control_word(s: str, i: int) -> tuple[str, int] | None:
    """If a command such as ``\\section`` starts at ``i``, return its name and end index."""
    if s[i] != "\\" or is_escaped(s, i):
        return None
    j = i + 1
    while j < len(s) and s[j].isascii() and s[j].isalpha():
        j += 1
    if j == i + 1:
        return None
    return s[i + 1 : j], j


def line_bounds(s: str, start: int, end: int) -> tuple[int, int]:
    """The start of the line holding ``start`` and the index just past the newline after ``end``."""
    line_start = s.rfind("\n", 0, start) + 1
    newline = s.find("\n", end)
    line_end = len(s) if newline == -1 else newline + 1
    return line_start, line_end


def split_skills(items: str) -> list[str]:
    """Split a skills list at commas. Commas inside parentheses stay put."""
    out = []
    depth = 0
    current = ""
    for ch in items:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(current.strip())
            current = ""
            continue
        current += ch
    if current.strip():
        out.append(current.strip())
    return out


# ---------------------------------------------------------------------------
# The parsed document
# ---------------------------------------------------------------------------


class TexDoc:
    def __init__(self, src: str, sections: list[str], slots: list[Slot], entries: list[Entry]):
        self.src = src
        self.sections = sections
        self.slots = slots
        self.entries = entries
        self._by_id = {slot.id: slot for slot in slots}

    @classmethod
    def parse(cls, src: str) -> TexDoc:
        body = src.find("\\begin{document}")
        if body == -1:
            raise NoDocument()
        sections: list[str] = []
        slots: list[Slot] = []
        entries: list[Entry] = []
        bullet_count = 0
        skills_count = 0
        i = body
        while i < len(src):
            if src[i] == "%" and not is_escaped(src, i):
                while i < len(src) and src[i] != "\n":
                    i += 1
                continue
            found = control_word(src, i)
            if found is None:
                i += 1
                continue
            word, after = found
            section = sections[-1] if sections else ""

            if word == "section":
                args, i = read_args(src, after, 1)
                sections.append(src[args[0][0] : args[0][1]])

            elif word == "resumeItem":
                args, next_i = read_args(src, after, 1)
                bullet_count += 1
                slot_id = f"b{bullet_count}"
                entry_index = None
                # A bullet belongs to the latest heading in the same section.
                if entries and entries[-1].section == section:
                    entries[-1].bullets.append(slot_id)
                    entry_index = entries[-1].index
                slots.append(
                    Slot(
                        id=slot_id,
                        kind=BULLET,
                        section=section,
                        entry=entry_index,
                        start=args[0][0],
                        end=args[0][1],
                        line=line_bounds(src, i, next_i),
                    )
                )
                i = next_i

            elif word in ("resumeSubheading", "resumeProjectHeading"):
                kind = SUBHEADING if word == "resumeSubheading" else PROJECT_HEADING
                args, i = read_args(src, after, 4 if kind == SUBHEADING else 2)
                index = len(entries)
                fields = []
                for arg, (start, end) in enumerate(args):
                    slot_id = f"h{index + 1}.{arg}"
                    fields.append(slot_id)
                    slots.append(
                        Slot(id=slot_id, kind=kind, arg=arg, section=section, entry=index, start=start, end=end)
                    )
                entries.append(Entry(index=index, section=section, kind=kind, fields=fields))

            elif word == "textbf" and "skill" in section.lower():
                # A skills line looks like \textbf{Label}{: a, b, c}
                args, next_i = read_args(src, after, 1)
                label = src[args[0][0] : args[0][1]]
                j = skip_spaces(src, next_i)
                if j < len(src) and src[j] == "{":
                    close = match_brace(src, j)
                    inner = src[j + 1 : close]
                    if inner.startswith(":"):
                        rest = inner[1:]
                        lead = 1 + (len(rest) - len(rest.lstrip()))
                        skills_count += 1
                        slots.append(
                            Slot(
                                id=f"s{skills_count}",
                                kind=SKILLS_LINE,
                                section=section,
                                label=label,
                                start=j + 1 + lead,
                                end=close,
                            )
                        )
                        i = close + 1
                        continue
                i = next_i

            else:
                i = after
        return cls(src, sections, slots, entries)

    # -- reading ------------------------------------------------------------

    def slot(self, slot_id: str) -> Slot | None:
        return self._by_id.get(slot_id)

    def raw(self, slot_id: str) -> str | None:
        """The LaTeX inside a slot, exactly as written."""
        slot = self.slot(slot_id)
        return None if slot is None else self.src[slot.start : slot.end]

    def text(self, slot_id: str) -> str | None:
        """A slot as plain text, or its raw LaTeX if it uses commands we don't convert."""
        raw = self.raw(slot_id)
        if raw is None:
            return None
        plain = tex_to_plain(raw)
        return raw if plain is None else plain

    def bullets(self) -> list[Slot]:
        return [s for s in self.slots if s.kind == BULLET]

    def skills_lines(self) -> list[Slot]:
        return [s for s in self.slots if s.kind == SKILLS_LINE]

    def skills(self) -> list[tuple[str, list[str]]]:
        """Each skills line as (label, skills), in plain text."""
        out = []
        for slot in self.skills_lines():
            label = slot.label or ""
            plain_label = tex_to_plain(label)
            out.append((label if plain_label is None else plain_label, split_skills(self.text(slot.id) or "")))
        return out

    def bullets_in(self, names: list[str]) -> list[Slot]:
        """Bullets in sections whose title contains one of ``names``, ignoring case."""
        wanted = [n.lower() for n in names]
        return [s for s in self.bullets() if any(n in s.section.lower() for n in wanted)]

    def entry_title(self, entry: int) -> str:
        """One line naming an entry, such as ``Northwind Logistics | Software Engineering Intern``."""
        e = self.entries[entry]
        # For a role, the company and the title. For a project, its name and stack.
        picks = [0, 2] if e.kind == SUBHEADING else [0]
        parts = [self.text(e.fields[k]) for k in picks if k < len(e.fields)]
        return " | ".join(p for p in parts if p is not None)

    def skeleton(self, removed: set[str]) -> str:
        """Everything outside the slots, with a NUL marking each slot.

        A removed bullet drops its whole line instead.
        """
        out = []
        pos = 0
        for slot in self.slots:
            if slot.id in removed and slot.line is not None:
                out.append(self.src[pos : slot.line[0]])
                pos = slot.line[1]
                continue
            out.append(self.src[pos : slot.start])
            out.append("\0")
            pos = slot.end
        out.append(self.src[pos:])
        return "".join(out)

    # -- editing ------------------------------------------------------------

    def apply(self, edits: list[SetText | SetRaw | Remove | ReorderSkills]) -> str:
        """Apply edits and return the new source.

        The result is checked with ``verify_preserved`` before it is returned, so a
        bad edit raises instead of producing a broken file.
        """
        replacements: list[tuple[int, int, str]] = []
        removed: set[str] = set()
        for edit in edits:
            slot = self.slot(edit.slot)
            if slot is None:
                raise UnknownSlot(edit.slot)

            if isinstance(edit, SetText):
                current = self.text(slot.id) or ""
                if edit.text.strip() == current.strip():
                    continue  # keep the original bytes when the text didn't change
                replacements.append((slot.start, slot.end, plain_to_tex(edit.text.strip())))

            elif isinstance(edit, SetRaw):
                if not braces_balanced(edit.tex):
                    raise BadRaw(slot.id)
                command = forbidden_command(edit.tex)
                if command is not None:
                    raise ForbiddenCommand(slot.id, command)
                replacements.append((slot.start, slot.end, edit.tex))

            elif isinstance(edit, Remove):
                if slot.line is None:
                    raise WrongKind(slot.id)
                removed.add(slot.id)
                replacements.append((slot.line[0], slot.line[1], ""))

            elif isinstance(edit, ReorderSkills):
                if slot.kind != SKILLS_LINE:
                    raise WrongKind(slot.id)
                replacements.append((slot.start, slot.end, self._reordered_skills(slot, edit.items)))

        out = self.src
        # Replace from the end of the file backwards so earlier positions stay valid.
        for start, end, text in sorted(replacements, key=lambda r: r[0], reverse=True):
            out = out[:start] + text + out[end:]
        verify_preserved(self, out, removed)
        return out

    def _reordered_skills(self, slot: Slot, items: list[str]) -> str:
        current = split_skills(self.src[slot.start : slot.end])
        wanted = [plain_to_tex(item.strip()) for item in items]
        if sorted(current) == sorted(wanted):
            return ", ".join(wanted)
        # The UI sends plain text, so "R&D" has to match the file's "R\&D".
        # Compare in plain text, then write each skill back in its original spelling.
        current_plain = [tex_to_plain(c) or c for c in current]
        items_plain = [item.strip() for item in items]
        if sorted(current_plain) != sorted(items_plain):
            raise SkillsMismatch(slot.id)
        return ", ".join(current[current_plain.index(item)] for item in items_plain)


def verify_preserved(original: TexDoc, edited: str, removed: set[str]) -> None:
    """Raise ``SkeletonChanged`` unless ``edited`` keeps the original skeleton and slots."""
    new = TexDoc.parse(edited)
    kinds_before = [(s.kind, s.arg) for s in original.slots if s.id not in removed]
    kinds_after = [(s.kind, s.arg) for s in new.slots]
    if kinds_before != kinds_after:
        raise SkeletonChanged(f"slot count changed from {len(kinds_before)} to {len(kinds_after)}")
    before = original.skeleton(removed)
    after = new.skeleton(set())
    if before != after:
        at = next((k for k, (x, y) in enumerate(zip(before, after)) if x != y), min(len(before), len(after)))
        raise SkeletonChanged(f"first difference at skeleton position {at}")
    if original.sections != new.sections:
        raise SkeletonChanged("section titles or order changed")


# Inline commands a hand-edited slot may use. Anything else (sections, list
# items, spacing, font sizes, reading files) could change the layout.
ALLOWED_INLINE = (
    "textbf",
    "emph",
    "textit",
    "underline",
    "href",
    "sim",
    "textbackslash",
    "textless",
    "textgreater",
)


def forbidden_command(tex: str) -> str | None:
    """The first command in ``tex`` that isn't on the allowlist, or None."""
    for i, c in enumerate(tex):
        if c != "\\" or is_escaped(tex, i):
            continue
        found = control_word(tex, i)
        if found is not None:
            if found[0] not in ALLOWED_INLINE:
                return found[0]
        elif tex[i + 1 : i + 2] == "\\":
            return "\\"  # a forced line break
    return None


def braces_balanced(s: str) -> bool:
    depth = 0
    for i, c in enumerate(s):
        if c == "{" and not is_escaped(s, i):
            depth += 1
        elif c == "}" and not is_escaped(s, i):
            depth -= 1
            if depth < 0:
                return False
    return depth == 0


# ---------------------------------------------------------------------------
# Plain text conversion
# ---------------------------------------------------------------------------

# LaTeX for one character, and the character it stands for.
_SIMPLE = [
    ("\\&", "&"),
    ("\\%", "%"),
    ("\\$", "$"),
    ("\\#", "#"),
    ("\\_", "_"),
    ("\\{", "{"),
    ("\\}", "}"),
    ("\\textbackslash{}", "\\"),
    ("\\textless{}", "<"),
    ("\\textgreater{}", ">"),
    ("\\^{}", "^"),
]

# Formatting commands shown with Markdown-style markers.
_WRAPPERS = [("\\textbf{", "**"), ("\\emph{", "*"), ("\\textit{", "*")]


def tex_to_plain(tex: str) -> str | None:
    """Turn slot LaTeX into plain text.

    Returns None when the text uses a command this function doesn't know. The
    slot is then shown as raw LaTeX and only the user can edit it.
    """
    out = []
    i = 0
    while i < len(tex):
        c = tex[i]
        rest = tex[i:]
        if c == "\\":
            simple = next(((p, r) for p, r in _SIMPLE if rest.startswith(p)), None)
            if simple is not None:
                out.append(simple[1])
                i += len(simple[0])
                continue
            wrapper = next(((p, m) for p, m in _WRAPPERS if rest.startswith(p)), None)
            if wrapper is not None:
                open_at = i + len(wrapper[0]) - 1
                try:
                    close = match_brace(tex, open_at)
                except Unbalanced:
                    return None
                inner = tex_to_plain(tex[open_at + 1 : close])
                if inner is None:
                    return None
                out.append(wrapper[1] + inner + wrapper[1])
                i = close + 1
                continue
            return None
        if c == "$":
            if rest.startswith("$\\sim$"):
                out.append("~")
                i += 6
            elif rest.startswith("$|$"):
                out.append("|")
                i += 3
            else:
                return None
        elif rest.startswith("``"):
            out.append("“")
            i += 2
        elif rest.startswith("''"):
            out.append("”")
            i += 2
        elif rest.startswith("---"):
            out.append("—")
            i += 3
        elif rest.startswith("--"):
            out.append("–")
            i += 2
        elif c == "~":
            out.append(" ")
            i += 1
        elif c in "{}":
            return None
        else:
            out.append(c)
            i += 1
    return "".join(out)


_ESCAPES = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    "&": "\\&",
    "%": "\\%",
    "$": "\\$",
    "#": "\\#",
    "_": "\\_",
    "^": "\\^{}",
    "~": "$\\sim$",
    "|": "$|$",
    "<": "\\textless{}",
    ">": "\\textgreater{}",
    "“": "``",
    "”": "''",
    "‘": "`",
    "’": "'",
    "–": "--",
    "—": "---",
    " ": " ",
    "\n": " ",
    "\r": " ",
    "\t": " ",
}


def plain_to_tex(plain: str) -> str:
    """Turn plain text into LaTeX, escaping every special character.

    ``**x**`` becomes bold and ``*x*`` becomes italic, the reverse of ``tex_to_plain``.
    """
    out = []
    i = 0
    open_quote = True
    while i < len(plain):
        c = plain[i]
        if c == "*":
            bold = plain[i + 1 : i + 2] == "*"
            marker = "**" if bold else "*"
            start = i + len(marker)
            end = plain.find(marker, start)
            if end > start:
                out.append("\\textbf{" if bold else "\\emph{")
                out.append(plain_to_tex(plain[start:end]))
                out.append("}")
                i = end + len(marker)
                continue
            out.append("*")
            i += 1
            continue
        if c == '"':
            # Straight double quotes alternate between opening and closing quotes.
            out.append("``" if open_quote else "''")
            open_quote = not open_quote
        else:
            out.append(_ESCAPES.get(c, c))
        i += 1
    return "".join(out)
