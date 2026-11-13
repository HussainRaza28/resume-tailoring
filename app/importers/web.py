"""Text out of a web page, such as a personal site, for the facts import.

The page's readable text is kept and its scripts, styles and navigation are
dropped. Links that look like a resume PDF are listed, so the user can choose
to read that too.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse

import httpx2
from bs4 import BeautifulSoup

from app.importers.files import MAX_BYTES, ReadError, pdf_text

TIMEOUT = httpx2.Timeout(20.0, connect=10.0)
# A plain client name: the request says what it is and nothing about the user.
HEADERS = {"user-agent": "Tailor/0.1 (resume tailoring app)"}
_RESUME_WORDS = re.compile(r"\b(resume|résumé|cv|curriculum vitae)\b", re.IGNORECASE)


@dataclass
class Page:
    url: str
    title: str
    text: str
    # Links that look like a resume PDF: {"url", "label"}.
    pdf_links: list[dict] = field(default_factory=list)


def check_url(url: str) -> str:
    """Only http and https pages, with a host. A bare domain gets https:// added."""
    url = url.strip()
    if "://" not in url:
        url = "https://" + url
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ReadError("invalid", "Enter a web address such as https://example.com.")
    return url


def fetch(url: str) -> httpx2.Response:
    try:
        resp = httpx2.get(url, headers=HEADERS, timeout=TIMEOUT, follow_redirects=True)
    except httpx2.TransportError as e:
        raise ReadError("offline", f"Could not reach {urlparse(url).netloc}.") from e
    if resp.status_code >= 400:
        raise ReadError("http", f"The page answered with HTTP {resp.status_code}.")
    if len(resp.content) > MAX_BYTES:
        raise ReadError("too_big", "That page is too large to read.")
    return resp


def is_pdf(resp: httpx2.Response) -> bool:
    return "pdf" in resp.headers.get("content-type", "").lower() or resp.content[:5] == b"%PDF-"


def page_from_html(url: str, html: str) -> Page:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(strip=True) if soup.title else urlparse(url).netloc
    links = []
    seen = set()
    for a in soup.find_all("a", href=True):
        target = urljoin(url, a["href"])
        label = a.get_text(" ", strip=True)
        looks_like_pdf = urlparse(target).path.lower().endswith(".pdf")
        if (looks_like_pdf or _RESUME_WORDS.search(label)) and target not in seen and target.startswith("http"):
            seen.add(target)
            links.append({"url": target, "label": label or target.rsplit("/", 1)[-1]})
    for tag in soup(["script", "style", "noscript", "nav", "footer", "svg", "form"]):
        tag.decompose()
    lines = [line.strip() for line in soup.get_text("\n").splitlines()]
    text = "\n".join(line for line in lines if line)
    return Page(url=url, title=title, text=text, pdf_links=links[:10])


def read_url(url: str) -> Page:
    """Fetch a page, or a PDF at a URL, and return its text."""
    url = check_url(url)
    resp = fetch(url)
    final = str(resp.url)
    if is_pdf(resp):
        return Page(url=final, title=final.rsplit("/", 1)[-1], text=pdf_text(resp.content))
    page = page_from_html(final, resp.text)
    if not page.text:
        raise ReadError("empty", "No readable text was found on that page.")
    return page
