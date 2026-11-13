"""The shapes the model must reply in, one per pipeline step.

Every model call asks for JSON that matches one of these. They're strict:
unknown fields are refused, and every field is required (a field that may be
empty is typed ``str | None`` with no default), because the structured-output
modes of the providers expect that.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RedFlag(Strict):
    flag: str
    why: str
    # The section it's in, named as in the resume.
    section: str


class RedFlagsReply(Strict):
    company: str
    role: str
    red_flags: list[RedFlag]


class Proposal(Strict):
    """One rewritten bullet, as the model proposes it."""

    bullet_id: str
    new_text: str
    # Ids the rewrite drew on: its own bullet id and any facts-bank ids.
    sources: list[str]
    # A question asking for a missing number, such as "How many users?".
    question: str | None
    why: str


class RewritesReply(Strict):
    rewrites: list[Proposal]


class SkippedSection(Strict):
    section: str
    reason: str
    rewrites: list[Proposal]


class ReviewReply(Strict):
    score: int
    verdict: str
    skipped_sections: list[SkippedSection]
