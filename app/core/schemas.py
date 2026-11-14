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


class SkippedSection(Strict):
    """A section a reader would skim past, and why."""

    section: str
    reason: str


class MissingKeyword(Strict):
    keyword: str
    # Ids of the bullets (b1, b2, ...) or facts (f1, f2, ...) that show the person has it.
    evidence: list[str]


class DiagnoseReply(Strict):
    company: str
    role: str
    ats_score: int
    hiring_manager_score: int
    verdict: str
    red_flags: list[RedFlag]
    skipped_sections: list[SkippedSection]
    missing_keywords: list[MissingKeyword]


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


class ChangeEffect(Strict):
    """How one changed bullet moves the tailored resume's score."""

    bullet_id: str
    # Points gained (positive) or lost (negative) against the original bullet.
    effect: int
    reason: str


class RescoreReply(Strict):
    base_ats_score: int
    base_hiring_manager_score: int
    tailored_ats_score: int
    tailored_hiring_manager_score: int
    verdict: str
    changes: list[ChangeEffect]
