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


class ScoreReply(Strict):
    """The first step: the base resume's ATS score and its top red flags. Kept small so it comes back fast."""

    company: str
    role: str
    ats_score: int
    red_flags: list[RedFlag]


class Proposal(Strict):
    """One rewritten bullet, as the model proposes it."""

    bullet_id: str
    new_text: str
    # Ids the rewrite drew on: its own bullet id and any facts-bank ids.
    sources: list[str]
    why: str


class RewritesReply(Strict):
    rewrites: list[Proposal]


class RescoreReply(Strict):
    """The base and the tailored resume, scored in the same reply."""

    base_ats_score: int
    tailored_ats_score: int
