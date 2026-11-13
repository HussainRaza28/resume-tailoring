"""The tailoring steps, run one after another:

1. Red flags: a recruiter's skim, the top 3 reasons to say no.
2. Rewrite: the Experience and Projects bullets, each citing its sources.
3. Review: an ATS and hiring-manager score, before and after, and the sections
   a reader would skip.

Every model call asks for JSON that matches a schema, and every proposed bullet
goes through the grounding check and the style rules before the user can
accept it. There is no summary step, and no way to add a summary section.
"""

from __future__ import annotations

from pydantic import BaseModel

from app.core import grounding, skills, style
from app.core.facts import FactsBank
from app.core.grounding import GroundingReport, Source
from app.core.schemas import Proposal, RedFlag, RedFlagsReply, ReviewReply, RewritesReply
from app.core.style import Violation
from app.core.tex import BULLET, SKILLS_LINE, Remove, ReorderSkills, SetText, TexDoc, split_skills, tex_to_plain
from app.providers.base import Completion, CompletionRequest, DeltaSink, Provider, ProviderError, Usage, ignore_deltas

# Sections whose bullets get rewritten, matched against the section title.
REWRITE_SECTIONS = ["experience", "project"]

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

SYSTEM = """You help one person tailor their own resume to one job posting.

Ground rules, which override anything else:
- Never invent anything. No new numbers, skills, tools, employers, titles, dates, awards or outcomes. Use only what is in the resume below or in the facts bank given with a request. A program checks every number, name and skill you write against the sources you cite and blocks anything it cannot find.
- Never suggest a summary, objective or profile section.
- Write plain text. No LaTeX, no Markdown, no emoji.
- Style: no em dashes, no lists of three added for rhythm, no "not X but Y" contrasts, none of the words leverage, seamless, robust, spearheaded, delve or synergy, no comparisons with the person's own earlier work, and no mentions of AI tools unless the original bullet already has them. Every number must make sense on its own.
- Be direct and specific. No compliments, no padding."""


def red_flags_prompt(company: str, posting: str) -> str:
    named = f" ({company.strip()})" if company.strip() else ""
    return (
        f"Act as a senior recruiter for this exact company{named}. Read my resume the way you'd actually read it, "
        "skimming for reasons to say no. Give me the top 3 red flags a hiring manager spots in under 10 seconds.\n\n"
        "Be brutally honest, with no compliments or padding. For each flag say why it hurts for this specific job "
        "and which resume section it is in (use the section names from the resume). Also give the company name and "
        "the role title as written in the posting.\n\n"
        f"<job_posting>\n{posting.strip()}\n</job_posting>"
    )


def rewrite_prompt(
    posting: str, flags: list[RedFlag], facts: str, bullets: list[tuple[str, str, str]], feedback: str
) -> str:
    flags_text = "".join(f"{i}. {f.flag} ({f.section}): {f.why}\n" for i, f in enumerate(flags, 1))
    bullets_text = "".join(f"[{bid}] ({entry}) {text}\n" for bid, entry, text in bullets)
    return (
        "Rewrite my experience section to kill those red flags. Lead every line with measurable impact using the "
        "Google XYZ formula and strip out every generic phrase.\n\n"
        f"Red flags:\n{flags_text}\n"
        "Rewrite these bullets (Experience and Projects). Return one entry per bullet id, in the same order. For each:\n"
        "- `new_text`: the rewritten bullet. Measurable impact is optional: only use numbers that appear in the "
        "cited sources. A bullet without a number is fine. Keep roughly the same length so the resume stays one page.\n"
        "- `sources`: the ids you drew on, always including the bullet's own id, plus any facts-bank ids (f1, f2, ...) "
        "you used.\n"
        "- `question`: if the bullet would be clearly stronger with a number you do not have, a short question asking "
        'for it, such as "How many users did the app have?". Otherwise null.\n'
        "- `why`: one short sentence on which red flag this fixes.\n"
        "If a bullet is already strong, return it unchanged.\n\n"
        f"<bullets>\n{bullets_text}</bullets>\n\n"
        f"<facts_bank>\n{facts}\n</facts_bank>\n"
        f"{feedback}\n"
        f"<job_posting>\n{posting.strip()}\n</job_posting>"
    )


def review_prompt(posting: str, resume_plain_text: str) -> str:
    return (
        "Act as both an ATS filter and a hiring manager reading 200 resumes in one sitting. Give me a match score out "
        "of 100, tell me which sections would get skipped, and rewrite them so they actually stop the scroll.\n\n"
        "Score the resume in <resume_to_score> (not the base resume in the system prompt, which is only the source of "
        "truth for facts). For each section that would get skipped, give the reason and rewrites for specific bullets "
        "by id. Each rewrite must cite its sources (the bullet's own id and any facts-bank ids). Only rewrite bullets "
        "in Experience and Projects. Do not suggest a summary or objective section.\n\n"
        f"<resume_to_score>\n{resume_plain_text}\n</resume_to_score>\n\n"
        f"<job_posting>\n{posting.strip()}\n</job_posting>"
    )


RETRY_FEEDBACK = (
    "\nYour previous rewrites of these bullets were blocked by the checker. Fix each one using only what the sources "
    "support, or return the original text:\n{lines}\n"
)

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

OK = "ok"  # passes grounding and style, so it can be accepted
BLOCKED = "blocked"  # fails a check, so it can't be accepted until fixed
UNCHANGED = "unchanged"  # same text as the original


class CheckedRewrite(BaseModel):
    """A proposed rewrite after the code checks."""

    bullet_id: str
    entry: str
    section: str
    old_text: str
    new_text: str
    sources: list[str]
    question: str | None
    why: str
    status: str
    grounding: GroundingReport
    style: list[Violation]
    # Plain-language reasons, grounding first.
    reasons: list[str]


class SkippedSectionResult(BaseModel):
    section: str
    reason: str
    rewrites: list[CheckedRewrite]


class Review(BaseModel):
    score: int
    verdict: str
    skipped_sections: list[SkippedSectionResult]


class StepStats(BaseModel):
    step: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    duration_ms: int = 0
    model: str = ""
    # Unsupported claims the grounding check found in this step's proposals,
    # counted before anything was blocked or retried.
    blocked_claims: int = 0
    style_violations: int = 0
    # Unsupported claims by kind ("number", "name", "skill") and violations by rule.
    blocked_by_kind: dict[str, int] = {}
    style_by_rule: dict[str, int] = {}

    def usage(self) -> Usage:
        return Usage(self.input_tokens, self.output_tokens, self.cache_read_tokens, self.cache_write_tokens)


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------


def _squash(s: str) -> str:
    return " ".join(s.split())


def clean_model_text(s: str) -> str:
    """Tidy model text: drop a leading bullet mark, wrapping quotes and a final period.

    The template's bullets have no final period.
    """
    t = s.strip().lstrip("-*•").strip()
    if len(t) >= 2 and t.startswith('"') and t.endswith('"'):
        t = t[1:-1]
    return _squash(t.rstrip("."))


def resume_plain(doc: TexDoc, replaced: dict[str, str], with_ids: bool) -> str:
    """The resume as plain text: sections, role headings, bullets and skills lines.

    ``replaced`` maps bullet ids to their current text. An empty string means
    the bullet was removed.
    """
    lines: list[str] = []
    last_section = ""
    last_entry: int | None = None
    for slot in doc.slots:
        if slot.section != last_section:
            lines.append(f"\n## {slot.section}")
            last_section = slot.section
            last_entry = None
        if slot.kind == BULLET:
            if slot.entry is not None and slot.entry != last_entry:
                lines.append(f"### {doc.entry_title(slot.entry)}")
                last_entry = slot.entry
            text = replaced.get(slot.id, doc.text(slot.id) or "")
            if not text:
                continue
            lines.append(f"- [{slot.id}] {text}" if with_ids else f"- {text}")
        elif slot.kind == SKILLS_LINE:
            label = slot.label or ""
            lines.append(f"{tex_to_plain(label) or label}: {doc.text(slot.id) or ''}")
    return "\n".join(lines).strip()


def facts_prompt_text(facts: FactsBank) -> str:
    if not facts.facts:
        return "(empty)"
    return "\n".join(f"[{f.id}] {f.text}" for f in facts.facts)


# ---------------------------------------------------------------------------
# Context and checks
# ---------------------------------------------------------------------------


class Context:
    """Everything a run needs that stays the same between steps."""

    def __init__(self, base_tex: str) -> None:
        self.doc = TexDoc.parse(base_tex)
        # Sent as the cached context on every call.
        self.base_plain = resume_plain(self.doc, {}, with_ids=True)

    def rewrite_targets(self) -> list[tuple[str, str, str]]:
        """(bullet id, role or project heading, text) for every bullet the rewrite step covers."""
        out = []
        for b in self.doc.bullets_in(REWRITE_SECTIONS):
            entry = self.doc.entry_title(b.entry) if b.entry is not None else ""
            out.append((b.id, entry, self.doc.text(b.id) or ""))
        return out

    def sources_for(self, bullet_id: str, cited: list[str], facts: FactsBank) -> list[Source]:
        """The cited bullets and facts, plus the heading of the bullet's own role or project."""
        sources = []
        for sid in cited:
            fact = facts.get(sid)
            slot = self.doc.slot(sid)
            if fact is not None:
                sources.append(Source(id=sid, text=fact.text))
            elif slot is not None and slot.kind == BULLET:
                sources.append(Source(id=sid, text=self.doc.text(sid) or ""))
        own = self.doc.slot(bullet_id)
        if own is not None and own.entry is not None:
            sources.append(Source(id="heading", text=self.doc.entry_title(own.entry)))
        return sources

    def check(self, proposal: Proposal, facts: FactsBank) -> CheckedRewrite | None:
        """Run the code checks on one proposal. None if it doesn't point at a bullet."""
        slot = self.doc.slot(proposal.bullet_id)
        if slot is None or slot.kind != BULLET:
            return None
        old_text = self.doc.text(proposal.bullet_id) or ""
        new_text = clean_model_text(proposal.new_text)
        cited = [s.strip() for s in proposal.sources]
        # A rewrite always draws on its own bullet; add it if the model forgot.
        if proposal.bullet_id not in cited:
            cited.insert(0, proposal.bullet_id)
        sources = self.sources_for(proposal.bullet_id, cited, facts)
        source_texts = [s.text for s in sources if s.id != "heading"]

        report = grounding.check(new_text, sources)
        violations = style.check_bullet(new_text, source_texts)
        reasons = report.reasons() + [f"{style.LABELS[v.rule]}: {v.message}" for v in violations]
        if _squash(new_text) == _squash(old_text):
            status = UNCHANGED
        elif report.ok() and not violations:
            status = OK
        else:
            status = BLOCKED

        question = (proposal.question or "").strip() or None
        # Don't ask again if the facts bank already has the answer.
        if question and facts.answer_for(old_text, question) is not None:
            question = None
        return CheckedRewrite(
            bullet_id=proposal.bullet_id,
            entry=self.doc.entry_title(slot.entry) if slot.entry is not None else "",
            section=slot.section,
            old_text=old_text,
            new_text=new_text,
            sources=cited,
            question=question,
            why=proposal.why,
            status=status,
            grounding=report,
            style=violations,
            reasons=reasons,
        )

    def check_all(
        self, proposals: list[Proposal], facts: FactsBank, targets: list[tuple[str, str, str]]
    ) -> list[CheckedRewrite]:
        """One checked result per target bullet, in target order.

        The first proposal for each bullet is used. A bullet the model skipped
        comes back unchanged.
        """
        out = []
        for bid, _entry, text in targets:
            proposal = next((p for p in proposals if p.bullet_id == bid), None)
            if proposal is None:
                proposal = Proposal(bullet_id=bid, new_text=text, sources=[bid], question=None, why="")
            checked = self.check(proposal, facts)
            if checked is not None:
                out.append(checked)
        return out

    def _request(self, step: str, user: str, schema: type[BaseModel], max_tokens: int) -> CompletionRequest:
        return CompletionRequest(
            step=step,
            system=SYSTEM,
            context=f"<base_resume>\n{self.base_plain}\n</base_resume>",
            user=user,
            schema=schema,
            max_tokens=max_tokens,
        )


def step_stats(step: str, completion: Completion, checked: list[CheckedRewrite] = ()) -> StepStats:
    by_kind: dict[str, int] = {}
    by_rule: dict[str, int] = {}
    kind_names = {grounding.NUMBER: "number", grounding.PROPER_NOUN: "name", grounding.SKILL: "skill"}
    for r in checked:
        for claim in r.grounding.unsupported():
            name = kind_names[claim.kind]
            by_kind[name] = by_kind.get(name, 0) + 1
        for v in r.style:
            by_rule[v.rule] = by_rule.get(v.rule, 0) + 1
    u = completion.usage
    return StepStats(
        step=step,
        input_tokens=u.input_tokens,
        output_tokens=u.output_tokens,
        cache_read_tokens=u.cache_read_tokens,
        cache_write_tokens=u.cache_write_tokens,
        duration_ms=completion.duration_ms,
        model=completion.model,
        blocked_claims=sum(len(r.grounding.unsupported()) + len(r.grounding.citation_errors) for r in checked),
        style_violations=sum(len(r.style) for r in checked),
        blocked_by_kind=by_kind,
        style_by_rule=by_rule,
    )


# ---------------------------------------------------------------------------
# The steps
# ---------------------------------------------------------------------------


def _asks_for_summary(flag: RedFlag) -> bool:
    return style.is_summary_section(flag.flag) and "add" in flag.flag.lower()


def red_flags(
    provider: Provider, ctx: Context, company: str, posting: str, on_delta: DeltaSink = ignore_deltas
) -> tuple[RedFlagsReply, StepStats]:
    request = ctx._request("red_flags", red_flags_prompt(company, posting), RedFlagsReply, 4000)
    completion = provider.complete(request, on_delta)
    reply: RedFlagsReply = completion.data
    # A flag that says to add a summary is dropped: the resume never gets one.
    reply.red_flags = [f for f in reply.red_flags if not _asks_for_summary(f)][:3]
    return reply, step_stats("red_flags", completion)


def rewrite(
    provider: Provider,
    ctx: Context,
    posting: str,
    flags: list[RedFlag],
    facts: FactsBank,
    only: list[str] | None = None,
    on_delta: DeltaSink = ignore_deltas,
) -> tuple[list[CheckedRewrite], list[StepStats]]:
    """Rewrite every target bullet (or only the ids in ``only``) and check each one.

    Blocked rewrites go back to the model once, with the checker's reasons.
    """
    targets = [t for t in ctx.rewrite_targets() if only is None or t[0] in only]
    facts_text = facts_prompt_text(facts)
    request = ctx._request("rewrite", rewrite_prompt(posting, flags, facts_text, targets, ""), RewritesReply, 16000)
    completion = provider.complete(request, on_delta)
    checked = ctx.check_all(completion.data.rewrites, facts, targets)
    stats = [step_stats("rewrite", completion, checked)]

    blocked = [r for r in checked if r.status == BLOCKED]
    if not blocked:
        return checked, stats

    lines = "\n".join(f'[{r.bullet_id}] "{r.new_text}": {" ".join(r.reasons)}' for r in blocked)
    blocked_ids = {r.bullet_id for r in blocked}
    retry_targets = [t for t in targets if t[0] in blocked_ids]
    user = rewrite_prompt(posting, flags, facts_text, retry_targets, RETRY_FEEDBACK.format(lines=lines))
    try:
        retry = provider.complete(ctx._request("rewrite_retry", user, RewritesReply, 8000), on_delta)
    except ProviderError:
        # The first attempt already gave a full result; a failed retry leaves it as is.
        return checked, stats
    retried = ctx.check_all(retry.data.rewrites, facts, retry_targets)
    stats.append(step_stats("rewrite_retry", retry, retried))
    by_id = {r.bullet_id: r for r in retried if r.status != BLOCKED}
    return [by_id.get(r.bullet_id, r) for r in checked], stats


def review(
    provider: Provider,
    ctx: Context,
    posting: str,
    replaced: dict[str, str],
    facts: FactsBank,
    step: str = "review",
    on_delta: DeltaSink = ignore_deltas,
) -> tuple[Review, StepStats]:
    """Score the resume as it stands, with ``replaced`` holding the accepted rewrites."""
    plain = resume_plain(ctx.doc, replaced, with_ids=True)
    completion = provider.complete(ctx._request(step, review_prompt(posting, plain), ReviewReply, 12000), on_delta)
    reply: ReviewReply = completion.data
    rewritable = {b.id for b in ctx.doc.bullets_in(REWRITE_SECTIONS)}
    sections = []
    every_rewrite = []
    for s in reply.skipped_sections:
        if style.is_summary_section(s.section):
            continue  # never a summary section, even if a model suggests one
        rewrites = []
        for proposal in s.rewrites:
            if proposal.bullet_id not in rewritable:
                continue
            checked = ctx.check(proposal, facts)
            if checked is None:
                continue
            # Compare with the current text (after accepted rewrites), not the base.
            current = replaced.get(checked.bullet_id)
            if current is not None:
                checked.old_text = current
                if _squash(current) == _squash(checked.new_text):
                    checked.status = UNCHANGED
            rewrites.append(checked)
            every_rewrite.append(checked)
        sections.append(SkippedSectionResult(section=s.section, reason=s.reason, rewrites=rewrites))
    result = Review(score=max(0, min(100, reply.score)), verdict=reply.verdict, skipped_sections=sections)
    return result, step_stats(step, completion, every_rewrite)


# ---------------------------------------------------------------------------
# Counted in code: coverage, skills order, export edits, trimming
# ---------------------------------------------------------------------------


def coverage_for(
    ctx: Context, posting_skills: skills.PostingSkills, replaced: dict[str, str], facts: FactsBank
) -> skills.Coverage:
    base = resume_plain(ctx.doc, {}, with_ids=False)
    current = resume_plain(ctx.doc, replaced, with_ids=False)
    return skills.coverage(posting_skills, current, base, [(f.id, f.text) for f in facts.facts])


def skills_reorder_edits(doc: TexDoc, posting: skills.PostingSkills) -> list[ReorderSkills]:
    """Move the posting's skills to the front of each skills line.

    Required matches first, then preferred, then other mentions, then the rest
    in their original order. Only reorders: no skill is added or dropped. An
    honors or awards line is left alone.
    """
    lex = skills.lexicon()

    def rank(item: str) -> int:
        found = lex.find(item)
        for i, tier in enumerate((posting.required, posting.preferred, posting.mentioned)):
            if any(s in tier for s in found):
                return i
        return 3

    edits = []
    for slot in doc.skills_lines():
        label = (slot.label or "").lower()
        if "honor" in label or "award" in label:
            continue
        items = split_skills(doc.text(slot.id) or "")
        # sorted() is stable, so equal ranks keep their original order.
        ordered = sorted(items, key=rank)
        if ordered != items:
            edits.append(ReorderSkills(slot=slot.id, items=ordered))
    return edits


def export_edits(
    doc: TexDoc, accepted: dict[str, str], removed: list[str], posting: skills.PostingSkills | None
) -> list[SetText | Remove | ReorderSkills]:
    """The edits that turn the base resume into the tailored one."""
    edits: list = [SetText(slot=bid, text=text) for bid, text in sorted(accepted.items()) if bid not in removed]
    edits += [Remove(slot=bid) for bid in removed]
    if posting is not None:
        edits += skills_reorder_edits(doc, posting)
    return edits


# Characters on one rendered bullet line in this template at \small, measured
# on the compiled sample: a full line holds about 113 characters.
CHARS_PER_LINE = 113


class TrimHint(BaseModel):
    bullet_id: str
    text: str
    lines: int
    # Characters to cut so the bullet loses its last line.
    cut_chars: int


def trim_hints(doc: TexDoc, current: dict[str, str]) -> list[TrimHint]:
    """Bullets whose last line is short, so a small cut saves a whole line.

    Used when the PDF runs over one page. It's an estimate from character
    counts; compiling again is the real check.
    """
    hints = []
    for b in doc.bullets_in(REWRITE_SECTIONS):
        text = current.get(b.id, doc.text(b.id) or "")
        n = len(text)
        lines = -(-n // CHARS_PER_LINE)  # rounded up
        if lines < 2:
            continue
        hints.append(TrimHint(bullet_id=b.id, text=text, lines=lines, cut_chars=n - (lines - 1) * CHARS_PER_LINE))
    return sorted(hints, key=lambda h: h.cut_chars)
