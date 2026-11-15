"""The base resume as a profile for the Tailor Autofill browser extension.

Settings has "Export for Autofill". It writes a JSON file the extension's
"Import from Tailor" reads: the contact details and links from the resume's
header, every education and work entry with its dates and bullets, the skills,
and the facts bank. The extension shows what would change before anything is
saved, and everything stays editable there.

Reading a resume this way is a best effort over the app's template: a role's
heading is ``\\resumeSubheading{Company}{Dates}{Title}{Location}`` (the title
and company may be swapped, which is detected), and a school's is
``{School}{Location}{Degree | Minor in ... | GPA: ...}{Dates}``. A field that
can't be read is left blank for the person to fill in.
"""

from __future__ import annotations

import re

from app.core.bold import strip_bold
from app.core.export import person_name
from app.core.facts import FactsBank
from app.core.tex import SUBHEADING, TexDoc

FORMAT = "tailor-autofill-profile"
VERSION = 1

_MONTHS = {
    m: i
    for i, names in enumerate(
        [
            ("jan", "january"),
            ("feb", "february"),
            ("mar", "march"),
            ("apr", "april"),
            ("may",),
            ("jun", "june"),
            ("jul", "july"),
            ("aug", "august"),
            ("sep", "sept", "september"),
            ("oct", "october"),
            ("nov", "november"),
            ("dec", "december"),
        ],
        1,
    )
    for m in names
}
_SEASONS = {"spring": 3, "summer": 6, "fall": 9, "autumn": 9, "winter": 1}
_DATE = re.compile(r"(?:([A-Za-z]+)\.?\s+)?((?:19|20)\d\d)|(\d{1,2})/((?:19|20)\d\d)")
_PRESENT = re.compile(r"\b(present|current|now|ongoing)\b", re.I)
_RANGE_SPLIT = re.compile(r"\s*(?:--|–|—|-|\bto\b)\s*")
_TITLE_WORDS = re.compile(
    r"\b(intern|engineer|developer|assistant|analyst|manager|researcher|scientist|lead|designer|consultant|"
    r"associate|specialist|coordinator|technician|tutor|teaching|fellow|director|officer|volunteer|"
    r"president|founder|member|representative|programmer|administrator|architect)\b",
    re.I,
)
_LOCATION = re.compile(r"^[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\b|^remote$|^[A-Z][A-Za-z .'-]+,\s*[A-Z][a-z]+", re.I)
_PHONE = re.compile(r"(\+?\d[\d\s().-]{7,}\d)")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_HREF = re.compile(r"\\href\{([^}]*)\}")


def month_year(text: str) -> str:
    """The first month and year in ``text`` as "YYYY-MM", or "" when there's no month and year."""
    m = _DATE.search(text)
    if not m:
        return ""
    if m.group(3):
        return f"{m.group(4)}-{int(m.group(3)):02d}"
    word = (m.group(1) or "").lower()
    month = _MONTHS.get(word) or _SEASONS.get(word)
    return f"{m.group(2)}-{month:02d}" if month else ""


def date_range(text: str) -> tuple[str, str, bool]:
    """(start, end, current) from "June 2025 -- August 2025", "Sept 2023 -- Present" or "Expected May 2027"."""
    plain = text.strip()
    current = bool(_PRESENT.search(plain))
    parts = [p for p in _RANGE_SPLIT.split(plain) if p.strip()]
    if len(parts) >= 2:
        return month_year(parts[0]), "" if current else month_year(parts[-1]), current
    # One date: an end date (graduation) unless it says it's ongoing.
    one = month_year(plain)
    return ("", one, False) if not current else (one, "", True)


def _plain(doc: TexDoc, slot_id: str) -> str:
    return " ".join(strip_bold(doc.text(slot_id) or "").replace("*", "").split())


def _is_date(text: str) -> bool:
    return bool(_DATE.search(text)) or bool(_PRESENT.search(text))


def _split_name(name: str) -> tuple[str, str]:
    parts = name.split()
    if not parts:
        return "", ""
    return parts[0], " ".join(parts[1:])


def _header(tex: str) -> str:
    """The resume's header: from \\begin{document} to the first \\section."""
    start = tex.find("\\begin{document}")
    end = tex.find("\\section", start)
    return tex[start : end if end != -1 else len(tex)]


def contact(tex: str) -> dict:
    """Name, email, phone and links from the header."""
    header = _header(tex)
    first, last = _split_name(person_name(tex))
    links = [h.strip() for h in _HREF.findall(header)]
    email = next((h[len("mailto:") :] for h in links if h.lower().startswith("mailto:")), "")
    if not email:
        m = _EMAIL.search(header)
        email = m.group(0) if m else ""
    web = [h for h in links if h.lower().startswith(("http://", "https://", "www."))]
    linkedin = next((h for h in web if "linkedin.com" in h.lower()), "")
    github = next((h for h in web if "github.com" in h.lower()), "")
    others = [h for h in web if h not in (linkedin, github)]
    # The phone is the header's run of digits that isn't inside a link.
    no_links = re.sub(r"\\href\{[^}]*\}\{[^}]*(?:\{[^}]*\}[^}]*)*\}", " ", header)
    m = _PHONE.search(no_links)
    phone = m.group(1).strip() if m else ""
    return {
        "firstName": first,
        "lastName": last,
        "email": email,
        "phone": phone,
        "linkedin": linkedin,
        "github": github,
        "portfolio": others[0] if others else "",
        "websites": others[1:],
    }


def _degree(text: str) -> dict:
    """"Bachelor of Science in Computer Science | Minor in Statistics | GPA: 3.8" in parts."""
    out = {"degree": "", "field": "", "minor": "", "gpa": ""}
    for part in [p.strip() for p in re.split(r"\s*[|;]\s*|,\s*(?=(?:minor|gpa)\b)", text, flags=re.I) if p.strip()]:
        minor = re.match(r"minors?\s*(?:in|:)?\s*(.+)", part, re.I)
        gpa = re.search(r"\bgpa\b\s*:?\s*([0-9.]+(?:\s*/\s*[0-9.]+)?)", part, re.I)
        if minor:
            out["minor"] = minor.group(1).strip()
        elif gpa:
            out["gpa"] = gpa.group(1).replace(" ", "")
        elif not out["degree"]:
            m = re.match(r"(.+?)\s+(?:in|of)\s+(?!science\b|arts\b|engineering\b)(.+)", part, re.I)
            if m and re.search(r"bachelor|master|associate|doctor|b\.?s|b\.?a|m\.?s|ph\.?d|diploma|certificate", m.group(1), re.I):
                out["degree"], out["field"] = m.group(1).strip(), m.group(2).strip()
            else:
                out["degree"] = part
    return out


def education(doc: TexDoc) -> list[dict]:
    out = []
    for e in doc.entries:
        if e.kind != SUBHEADING or "educat" not in e.section.lower():
            continue
        fields = [_plain(doc, f) for f in e.fields]
        dates = next((f for f in fields[1:] if _is_date(f)), "")
        detail = next((f for f in fields[1:] if f and f != dates and not _LOCATION.match(f)), "")
        start, end, _ = date_range(dates)
        entry = {"school": fields[0], **_degree(detail), "start": start, "end": end}
        # A GPA written as a bullet ("GPA: 3.8/4.0") counts too.
        for b in e.bullets:
            m = re.search(r"\bgpa\b\s*:?\s*([0-9.]+(?:\s*/\s*[0-9.]+)?)", _plain(doc, b), re.I)
            if m and not entry["gpa"]:
                entry["gpa"] = m.group(1).replace(" ", "")
        out.append(entry)
    return out


def work(doc: TexDoc) -> list[dict]:
    out = []
    for e in doc.entries:
        section = e.section.lower()
        if e.kind != SUBHEADING or "educat" in section or "project" in section:
            continue
        fields = [_plain(doc, f) for f in e.fields] + ["", "", "", ""]
        company, dates, title, location = fields[:4]
        if not _is_date(dates) and _is_date(location):
            dates, location = location, dates
        # Jake's own template puts the title first; this one puts the company first.
        if _TITLE_WORDS.search(company) and not _TITLE_WORDS.search(title):
            company, title = title, company
        start, end, current = date_range(dates)
        out.append(
            {
                "title": title,
                "company": company,
                "location": location,
                "current": current,
                "start": start,
                "end": end,
                "bullets": [_plain(doc, b) for b in e.bullets],
            }
        )
    return out


def skills(doc: TexDoc) -> list[str]:
    seen: set[str] = set()
    out = []
    for _label, items in doc.skills():
        for item in items:
            clean = " ".join(item.split())
            if clean and clean.lower() not in seen:
                seen.add(clean.lower())
                out.append(clean)
    return out


def autofill_profile(tex: str, facts: FactsBank) -> dict:
    """The JSON the extension imports. Only fields the resume has are filled."""
    doc = TexDoc.parse(tex)
    return {
        "format": FORMAT,
        "version": VERSION,
        "profile": {
            **contact(tex),
            "education": education(doc),
            "work": work(doc),
            "skills": skills(doc),
        },
        "facts": [f.text for f in facts.facts],
    }

