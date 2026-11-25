"""The offline Demo provider.

It builds its replies from the request itself, with no key and no network, so
the whole flow can be tried (and tested end to end) on any computer. The
interface labels it "Demo", and its scores are a simple count, not a real reading.
"""

from __future__ import annotations

import re

from app.providers.base import CompletionRequest, DeltaSink, Provider, RawReply, Usage, to_json_text

# Bullet lines in the rewrite message: "[b2] (Northwind Logistics | Intern) Built a ..."
_REWRITE_LINE = re.compile(r"^\[(b\d+)\] \(([^)]*)\) (.+)$", re.MULTILINE)
# Bullet lines in a resume, with or without an id: "- [b2] Built a ..." or "- Built a ..."
_SCORE_LINE = re.compile(r"^- (?:\[b\d+\] )?(.+)$", re.MULTILINE)

# Openers that say what a team did instead of what the person did.
_VAGUE = ["Worked with ", "Helped ", "Responsible for ", "Assisted ", "Was part of ", "Participated in "]
_REPLACEMENTS = {"Worked with ": "Worked alongside ", "Helped ": "Supported "}

_RED_FLAGS = [
    {
        "flag": "Vague teamwork bullet with no outcome",
        "why": "Says what the team did, not what you shipped, so it reads as filler for a hands-on role.",
        "section": "Experience",
    },
    {
        "flag": "Impact stated without scale",
        "why": "Some bullets name a feature but not who used it or how much it moved.",
        "section": "Projects",
    },
    {
        "flag": "Posting's core stack sits last in the skills list",
        "why": "A ten-second skim reads the first few skills on each line and stops.",
        "section": "Technical Skills",
    },
]

# How much each kind of bullet moves the demo score.
_BASE_SCORE = 52
_PER_SPECIFIC_BULLET = 3
_PER_VAGUE_BULLET = 6

# Stream in pieces this long, so the live view has something to show.
_CHUNK = 64


def rewrite_line(text: str) -> str:
    """Swap a vague opener for a plainer one. Other bullets stay as they are."""
    for opener in _VAGUE:
        if text.startswith(opener):
            return _REPLACEMENTS.get(opener, "Handled ") + text[len(opener) :]
    return text


class DemoProvider(Provider):
    kind = "demo"
    label = "Offline demo"

    def __init__(self) -> None:
        super().__init__("demo")

    def _send(self, request: CompletionRequest, on_delta: DeltaSink) -> RawReply:
        step = request.step
        if step == "score":
            reply = {
                "company": "",
                "role": _first_posting_line(request.user),
                "ats_score": _demo_score([m.group(1) for m in _SCORE_LINE.finditer(request.context)]),
                "red_flags": _RED_FLAGS,
            }
        elif step.startswith("rewrite"):
            rewrites = [self._proposal(m.group(1), m.group(3)) for m in _REWRITE_LINE.finditer(request.user)]
            reply = {"rewrites": rewrites, "items": _items(request.user, rewrites)}
        elif step == "suggest_facts":
            reply = {"facts": [{"text": t, "quote": t} for t in _sentences_with_numbers(request.user)]}
        elif step == "rescore":
            reply = {
                "base_ats_score": _demo_score(_bullets_in(request.user, "resume_a")),
                "tailored_ats_score": _demo_score(_bullets_in(request.user, "resume_b")),
            }
        else:
            raise ValueError(f"the Demo provider has no reply for step {step!r}")

        text = to_json_text(reply)
        for i in range(0, len(text), _CHUNK):
            on_delta(text[i : i + _CHUNK])
        # Roughly four characters per token, close enough for a cost line that reads $0.00.
        usage = Usage(input_tokens=(len(request.context) + len(request.user)) // 4, output_tokens=len(text) // 4)
        return RawReply(text=text, usage=usage, model=self.model)

    @staticmethod
    def _proposal(bullet_id: str, text: str) -> dict:
        new_text = rewrite_line(text)
        return {
            "bullet_id": bullet_id,
            "new_text": new_text,
            "sources": [bullet_id],
            "why": "Removes a generic opener" if new_text != text else "",
        }


# Advice items and notes in the rewrite message: "[a1] Vague teamwork bullet ..." or "[n1] (fact f2) ...".
_ITEM_LINE = re.compile(r"^\[([an]\d+)\] ", re.MULTILINE)


def _items(message: str, rewrites: list[dict]) -> list[dict]:
    """The demo's report: the first advice item is the vague-opener fix when it made one; the rest it can't do."""
    changed = [r["bullet_id"] for r in rewrites if r["why"]]
    out = []
    for item_id in dict.fromkeys(_ITEM_LINE.findall(message)):
        if item_id == "a1" and changed:
            out.append({"item_id": item_id, "applied": True, "line_ids": changed, "why": "Replaced vague openers"})
        else:
            out.append({"item_id": item_id, "applied": False, "line_ids": [],
                        "why": "The offline demo only replaces vague openers."})
    return out


def _sentences_with_numbers(message: str, limit: int = 5) -> list[str]:
    """Sentences in the <document> part of a message that contain a number: the demo's facts."""
    document = message.split("<document>", 1)[1].split("</document>", 1)[0] if "<document>" in message else ""
    pieces = re.split(r"(?<=[.!?])\s+|\n+", document)
    found = [p.strip().rstrip(".") for p in pieces if any(c.isdigit() for c in p) and len(p.split()) >= 4]
    return found[:limit]


def _first_posting_line(message: str) -> str:
    posting = message.split("<job_posting>", 1)[1] if "<job_posting>" in message else ""
    lines = posting.strip().splitlines()
    return lines[0].strip() if lines else ""


def _bullets_in(message: str, tag: str) -> list[str]:
    """Bullet texts inside <tag>...</tag> in a message."""
    opening = f"<{tag}>\n"  # the instructions also name the tag, mid-sentence
    part = message.split(opening, 1)[1].split(f"</{tag}>", 1)[0] if opening in message else ""
    return [m.group(1) for m in _SCORE_LINE.finditer(part)]


def _demo_score(bullets: list[str]) -> int:
    specific = sum(1 for b in bullets if any(c.isdigit() for c in b))
    vague = sum(1 for b in bullets if b.startswith(tuple(_VAGUE)))
    return max(0, min(100, _BASE_SCORE + _PER_SPECIFIC_BULLET * specific - _PER_VAGUE_BULLET * vague))
