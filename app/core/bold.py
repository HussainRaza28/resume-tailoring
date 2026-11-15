"""Bold text in bullets, written as ``**phrase**`` in plain text.

A slot's ``\\textbf{...}`` shows up as ``**...**`` in its plain text (tex.py).
Rewrites go back through ``keep_bold`` so the template's bold survives:

* a phrase that was bold in the original stays bold when the rewrite still has it;
* the model may bold one more phrase, the key result, but only with words that
  are already in the original bullet, and only a short one.

Anything else the model marked as bold is unmarked. The checks (grounding,
style, dropped details) read the text without the markers.
"""

from __future__ import annotations

import re

_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")

# The longest phrase, in words, the model may newly bold.
MAX_NEW_BOLD_WORDS = 8
# How many phrases the model may newly bold in one bullet.
MAX_NEW_BOLD = 1


def bold_phrases(text: str) -> list[str]:
    """The bold phrases in ``text``, in order."""
    return [m.group(1).strip() for m in _BOLD_RE.finditer(text) if m.group(1).strip()]


def strip_bold(text: str) -> str:
    """``text`` without its ``**`` markers."""
    return _BOLD_RE.sub(lambda m: m.group(1), text)


def _mark(plain: str, phrases: list[str]) -> str:
    """Bold the first whole-word match of each phrase in ``plain``, never overlapping."""
    taken: list[tuple[int, int]] = []
    # Longer phrases first, so "cut costs 40%" wins over "40%".
    for phrase in sorted(set(phrases), key=len, reverse=True):
        pattern = re.compile(r"(?<![\w])" + re.escape(phrase) + r"(?![\w])")
        for m in pattern.finditer(plain):
            if all(m.end() <= a or m.start() >= b for a, b in taken):
                taken.append((m.start(), m.end()))
                break
    out = plain
    for start, end in sorted(taken, reverse=True):
        out = out[:start] + "**" + out[start:end] + "**" + out[end:]
    return out


def keep_bold(old_text: str, new_text: str) -> str:
    """The rewrite with the original's bold kept and only allowed new bold added."""
    old_plain = strip_bold(old_text)
    new_plain = strip_bold(new_text)
    kept = [p for p in bold_phrases(old_text) if p in new_plain]
    added = []
    for phrase in bold_phrases(new_text):
        if phrase in kept or len(added) >= MAX_NEW_BOLD:
            continue
        if len(phrase.split()) <= MAX_NEW_BOLD_WORDS and phrase in old_plain:
            added.append(phrase)
    return _mark(new_plain, kept + added)
