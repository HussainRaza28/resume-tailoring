"""Naming the exported PDF.

The file is named after the person on the resume and the company, such as
``Jordan_Sample_Resume_Larkspur_Freight.pdf``. The person's name comes from the
resume itself, so nothing personal is built into the app.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.core.tex import is_escaped, match_brace, tex_to_plain

# The template puts the name in a \Huge line at the top: \textbf{\Huge \scshape Jordan Sample}
_HUGE = re.compile(r"\\Huge\b")
_COMMAND = re.compile(r"\\[A-Za-z]+\s*")


def person_name(tex: str) -> str:
    """The name in the resume's header, or an empty string if it can't be found."""
    body_start = tex.find("\\begin{document}")
    m = _HUGE.search(tex, body_start if body_start != -1 else 0)
    if m is None:
        return ""
    # The name runs from \Huge to the end of the group it's in.
    open_at = tex.rfind("{", 0, m.start())
    while open_at > 0 and is_escaped(tex, open_at):
        open_at = tex.rfind("{", 0, open_at)
    try:
        close = match_brace(tex, open_at)
    except Exception:
        return ""
    inner = _COMMAND.sub("", tex[m.end() : close]).strip()
    plain = tex_to_plain(inner)
    return " ".join((plain if plain is not None else inner).split())


def _file_part(text: str) -> str:
    """Letters, digits and hyphens, with anything else turned into single underscores."""
    return re.sub(r"[^A-Za-z0-9-]+", "_", text.strip()).strip("_")


def unused_path(folder: Path, name: str) -> Path:
    """``folder/name``, or with _v2, _v3 and so on before the extension when that file exists.

    Export never replaces a file: an earlier resume for the same company is kept.
    """
    path = folder / name
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    n = 2
    while (folder / f"{stem}_v{n}{suffix}").exists():
        n += 1
    return folder / f"{stem}_v{n}{suffix}"


def export_file_name(name: str, company: str) -> str:
    """``<Name>_Resume_<Company>.pdf``, with each part reduced to safe characters."""
    parts = [p for p in (_file_part(name), "Resume", _file_part(company)) if p]
    return "_".join(parts) + ".pdf"
