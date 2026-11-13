"""Text out of files dropped on the facts import: PDF, Word (.docx), text and Markdown."""

from __future__ import annotations

import io

from docx import Document
from pypdf import PdfReader
from pypdf.errors import PdfReadError

SUPPORTED = (".pdf", ".docx", ".txt", ".md")
MAX_BYTES = 10_000_000


class ReadError(Exception):
    """A file or page that can't be read. ``kind`` is a short name for the interface."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


def pdf_text(data: bytes) -> str:
    try:
        reader = PdfReader(io.BytesIO(data))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    except PdfReadError as e:
        raise ReadError("unreadable", f"That PDF could not be read: {e}") from e


def docx_text(data: bytes) -> str:
    try:
        doc = Document(io.BytesIO(data))
    except Exception as e:  # python-docx raises several error types for broken files
        raise ReadError("unreadable", "That Word file could not be read.") from e
    lines = [p.text for p in doc.paragraphs]
    # Resumes often keep their content in tables, so read the cells too.
    for table in doc.tables:
        for row in table.rows:
            lines.append(" | ".join(cell.text for cell in row.cells))
    return "\n".join(lines)


def extract_text(name: str, data: bytes) -> str:
    """The text in a file, chosen by its extension."""
    lower = name.lower()
    if not lower.endswith(SUPPORTED):
        raise ReadError("unsupported", "Use a PDF, Word (.docx), text or Markdown file.")
    if len(data) > MAX_BYTES:
        raise ReadError("too_big", f"That file is over {MAX_BYTES // 1_000_000} MB.")
    if lower.endswith(".pdf"):
        text = pdf_text(data)
    elif lower.endswith(".docx"):
        text = docx_text(data)
    else:
        text = data.decode("utf-8", errors="replace")
    text = "\n".join(line.rstrip() for line in text.splitlines()).strip()
    if not text:
        raise ReadError("empty", "No text was found in that file. A scanned PDF has no text to read.")
    return text
