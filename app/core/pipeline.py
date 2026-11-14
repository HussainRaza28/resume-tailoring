"""The tailoring steps, run one after another:

1. Diagnose: score the base resume as an ATS filter and as a hiring manager,
   find the top 3 red flags, the sections a reader would skip and the posting's
   keywords the person can back up but doesn't show.
2. Rewrite: the Experience and Projects bullets, aimed at what Diagnose found,
   each citing its sources.
3. Re-score: the base and the rewritten resume scored side by side in one call,
   with the effect of each change, so a change that costs points can be undone.

Every model call asks for JSON that matches a schema, and every proposed bullet
goes through the grounding check and the style rules before the user can
accept it. There is no summary step, and no way to add a summary section.
"""

from __future__ import annotations

from pydantic import BaseModel

from app.core import grounding, skills, style
from app.core.facts import FactsBank
from app.core.grounding import GroundingReport, Source
from app.core.schemas import DiagnoseReply, Proposal, RedFlag, RescoreReply, RewritesReply, SkippedSection
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


# Shared by Diagnose and Re-score, so their numbers mean the same thing.
RUBRIC = """Scoring rubric. Use it exactly, so scores can be compared:
- ats_score: how many of the posting's required and preferred skills and terms appear on the resume, and whether job titles and section headings are standard and easy to parse.
- hiring_manager_score: whether bullets lead with concrete, measurable impact, how relevant the experience is to this role, and how fast the fit is clear in a 10-second skim."""


def diagnose_prompt(company: str, posting: str, facts: str) -> str:
    named = f" ({company.strip()})" if company.strip() else ""
    return (
        "Act as both an ATS filter and a hiring manager reading 200 resumes in one sitting, and as a senior recruiter "
        f"for this exact company{named}. Read my resume the way you'd actually read it, skimming for reasons to say no.\n\n"
        f"{RUBRIC}\n\n"
        "Give me:\n"
        "- A match score out of 100 as the ATS filter (`ats_score`) and as the hiring manager (`hiring_manager_score`).\n"
        "- The top 3 red flags a hiring manager spots in under 10 seconds (`red_flags`). Be brutally honest, with no "
        "compliments or padding. For each flag say why it hurts for this specific job and which resume section it is in "
        "(use the section names from the resume).\n"
        "- Which sections would get skipped, and why (`skipped_sections`).\n"
        "- Keywords from the posting that are missing from the resume or easy to miss, but only ones my resume or facts "
        "bank shows I have (`missing_keywords`). For each, list the ids of the bullets (b1, b2, ...) or facts (f1, f2, "
        "...) that show it in `evidence`. Leave out anything I have no evidence for.\n"
        "- `verdict`: two or three sentences on how the resume reads for this role.\n"
        "Also give the company name and the role title as written in the posting. Do not suggest a summary, objective "
        "or profile section.\n\n"
        f"<facts_bank>\n{facts}\n</facts_bank>\n\n"
        f"<job_posting>\n{posting.strip()}\n</job_posting>"
    )


def _diagnosis_text(diagnosis: Diagnosis | None) -> str:
    if diagnosis is None:
        return "(none)\n"
    flags = "".join(f"{i}. {f.flag} ({f.section}): {f.why}\n" for i, f in enumerate(diagnosis.red_flags, 1))
    skipped = "".join(f"- {s.section}: {s.reason}\n" for s in diagnosis.skipped_sections) or "(none)\n"
    keywords = (
        "".join(f"- {k.keyword} (shown by {', '.join(k.evidence)})\n" for k in diagnosis.missing_keywords) or "(none)\n"
    )
    return f"Red flags:\n{flags}\nSections that get skipped:\n{skipped}\nMissing keywords I can back up:\n{keywords}"


def rewrite_prompt(
    posting: str, diagnosis: Diagnosis | None, facts: str, bullets: list[tuple[str, str, str]], feedback: str
) -> str:
    bullets_text = "".join(f"[{bid}] ({entry}) {text}\n" for bid, entry, text in bullets)
    return (
        "Rewrite my experience section to fix exactly what the diagnosis below found: kill those red flags, make the "
        "skipped sections worth reading, and work in the missing keywords where a bullet's sources back them up. Lead "
        "every line with measurable impact using the Google XYZ formula (accomplished X, as measured by Y, by doing Z) "
        "and strip out every generic phrase.\n\n"
        f"{_diagnosis_text(diagnosis)}\n"
        "Rewrite these bullets (Experience and Projects). Return one entry per bullet id, in the same order. For each:\n"
        "- `new_text`: the rewritten bullet. Measurable impact is optional: only use numbers that appear in the "
        "cited sources. A bullet without a number is fine. Keep roughly the same length so the resume stays one page.\n"
        "- `sources`: the ids you drew on, always including the bullet's own id, plus any facts-bank ids (f1, f2, ...) "
        "you used.\n"
        "- `question`: if the bullet would be clearly stronger with a number you do not have, a short question asking "
        'for it, such as "How many users did the app have?". Otherwise null.\n'
        "- `why`: one short sentence on which finding from the diagnosis this fixes.\n"
        "If a bullet is already strong, return it unchanged.\n\n"
        f"<bullets>\n{bullets_text}</bullets>\n\n"
        f"<facts_bank>\n{facts}\n</facts_bank>\n"
        f"{feedback}\n"
        f"<job_posting>\n{posting.strip()}\n</job_posting>"
    )


def rescore_prompt(posting: str, base_plain: str, tailored_plain: str, changes: list[tuple[str, str, str]]) -> str:
    changes_text = "".join(f"[{bid}]\n  before: {old}\n  after: {new}\n" for bid, old, new in changes) or "(none)\n"
    return (
        "Act as both an ATS filter and a hiring manager reading 200 resumes in one sitting. Score two versions of my "
        "resume for this job in this one reply, with the same rubric, so the comparison is fair: <resume_a> is the base "
        "resume and <resume_b> is the tailored one.\n\n"
        f"{RUBRIC}\n\n"
        "Give the ATS and hiring manager scores out of 100 for both (`base_...` for resume A, `tailored_...` for resume "
        "B). Then, for every changed bullet in <changes>, give `effect`: how many points that change alone moves "
        "resume B's score compared with keeping the original bullet. Use a negative number if the change makes the "
        "resume worse, and 0 if it makes no difference. Add one short sentence in `reason`. `verdict`: two or three "
        "sentences on how the tailored resume reads now. Do not suggest a summary, objective or profile section.\n\n"
        f"<resume_a>\n{base_plain}\n</resume_a>\n\n"
        f"<resume_b>\n{tailored_plain}\n</resume_b>\n\n"
        f"<changes>\n{changes_text}</changes>\n\n"
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


class ScoreCard(BaseModel):
    ats: int
    hiring_manager: int
    # The headline number: the mean of the two, worked out here rather than by the model.
    overall: int

    @classmethod
    def of(cls, ats: int, hiring_manager: int) -> ScoreCard:
        ats, hiring_manager = _clamp(ats), _clamp(hiring_manager)
        return cls(ats=ats, hiring_manager=hiring_manager, overall=round((ats + hiring_manager) / 2))


class KeywordFinding(BaseModel):
    keyword: str
    # Bullet and fact ids that back it up, checked in code.
    evidence: list[str]


class Diagnosis(BaseModel):
    company: str = ""
    role: str = ""
    score: ScoreCard
    verdict: str = ""
    red_flags: list[RedFlag] = []
    skipped_sections: list[SkippedSection] = []
    missing_keywords: list[KeywordFinding] = []


class ChangeResult(BaseModel):
    bullet_id: str
    effect: int
    reason: str

    @property
    def lowers_score(self) -> bool:
        return self.effect < 0


class Rescore(BaseModel):
    base: ScoreCard
    tailored: ScoreCard
    verdict: str = ""
    changes: list[ChangeResult] = []
    # The bullet texts that were scored, so the interface can tell when a
    # decision made afterwards has made the scores out of date.
    scored: dict[str, str] = {}


class StepStats(BaseModel):
    step: str
    usage: Usage = Usage()
    duration_ms: int = 0
    model: str = ""
    # Unsupported claims the grounding check found in this step's proposals,
    # counted before anything was blocked or retried.
    blocked_claims: int = 0
    style_violations: int = 0
    # Unsupported claims by kind ("number", "name", "skill") and violations by rule.
    blocked_by_kind: dict[str, int] = {}
    style_by_rule: dict[str, int] = {}


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
    return StepStats(
        step=step,
        usage=completion.usage,
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


def _clamp(score: int) -> int:
    return max(0, min(100, score))


def _asks_for_summary(flag: RedFlag) -> bool:
    return style.is_summary_section(flag.flag) and "add" in flag.flag.lower()


def _backed_keywords(ctx: Context, reply: DiagnoseReply, facts: FactsBank) -> list[KeywordFinding]:
    """Keep a missing keyword only when a cited bullet or fact really mentions it.

    The skills lexicon matches a skill under any of its names (Postgres and
    PostgreSQL, say); anything else must appear word for word.
    """
    lex = skills.lexicon()
    out: list[KeywordFinding] = []
    for item in reply.missing_keywords:
        keyword = item.keyword.strip()
        if not keyword or any(k.keyword.lower() == keyword.lower() for k in out):
            continue
        canonical = lex.find(keyword)
        backed = []
        for sid in item.evidence:
            sid = sid.strip()
            fact = facts.get(sid)
            slot = ctx.doc.slot(sid)
            text = fact.text if fact is not None else ctx.doc.text(sid) if slot is not None else None
            if text is None:
                continue
            named = any(lex.contains(text, c) for c in canonical)
            if named or skills.contains_token(skills.normalize(text), skills.normalize(keyword)):
                backed.append(sid)
        if backed:
            out.append(KeywordFinding(keyword=keyword, evidence=backed))
    return out


def diagnose(
    provider: Provider,
    ctx: Context,
    company: str,
    posting: str,
    facts: FactsBank,
    on_delta: DeltaSink = ignore_deltas,
) -> tuple[Diagnosis, StepStats]:
    request = ctx._request("diagnose", diagnose_prompt(company, posting, facts_prompt_text(facts)), DiagnoseReply, 6000)
    completion = provider.complete(request, on_delta)
    reply: DiagnoseReply = completion.data
    result = Diagnosis(
        company=reply.company,
        role=reply.role,
        score=ScoreCard.of(reply.ats_score, reply.hiring_manager_score),
        verdict=reply.verdict,
        # A flag that says to add a summary is dropped: the resume never gets one.
        red_flags=[f for f in reply.red_flags if not _asks_for_summary(f)][:3],
        skipped_sections=[s for s in reply.skipped_sections if not style.is_summary_section(s.section)],
        missing_keywords=_backed_keywords(ctx, reply, facts),
    )
    return result, step_stats("diagnose", completion)


def rewrite(
    provider: Provider,
    ctx: Context,
    posting: str,
    diagnosis: Diagnosis | None,
    facts: FactsBank,
    only: list[str] | None = None,
    on_delta: DeltaSink = ignore_deltas,
) -> tuple[list[CheckedRewrite], list[StepStats]]:
    """Rewrite every target bullet (or only the ids in ``only``) and check each one.

    Blocked rewrites go back to the model once, with the checker's reasons.
    """
    targets = [t for t in ctx.rewrite_targets() if only is None or t[0] in only]
    facts_text = facts_prompt_text(facts)
    user = rewrite_prompt(posting, diagnosis, facts_text, targets, "")
    completion = provider.complete(ctx._request("rewrite", user, RewritesReply, 16000), on_delta)
    checked = ctx.check_all(completion.data.rewrites, facts, targets)
    stats = [step_stats("rewrite", completion, checked)]

    blocked = [r for r in checked if r.status == BLOCKED]
    if not blocked:
        return checked, stats

    lines = "\n".join(f'[{r.bullet_id}] "{r.new_text}": {" ".join(r.reasons)}' for r in blocked)
    blocked_ids = {r.bullet_id for r in blocked}
    retry_targets = [t for t in targets if t[0] in blocked_ids]
    user = rewrite_prompt(posting, diagnosis, facts_text, retry_targets, RETRY_FEEDBACK.format(lines=lines))
    try:
        retry = provider.complete(ctx._request("rewrite_retry", user, RewritesReply, 8000), on_delta)
    except ProviderError:
        # The first attempt already gave a full result; a failed retry leaves it as is.
        return checked, stats
    retried = ctx.check_all(retry.data.rewrites, facts, retry_targets)
    stats.append(step_stats("rewrite_retry", retry, retried))
    by_id = {r.bullet_id: r for r in retried if r.status != BLOCKED}
    return [by_id.get(r.bullet_id, r) for r in checked], stats


def rescore(
    provider: Provider,
    ctx: Context,
    posting: str,
    replaced: dict[str, str],
    on_delta: DeltaSink = ignore_deltas,
) -> tuple[Rescore, StepStats]:
    """Score the base resume and the current one (``replaced`` holds the accepted
    changes) in a single call, with the effect of each change.

    Two separate calls would each carry their own run-to-run noise, so a small
    gain could show up as a loss. One call scores both with the same reading.
    """
    base_plain = resume_plain(ctx.doc, {}, with_ids=True)
    tailored_plain = resume_plain(ctx.doc, replaced, with_ids=True)
    changes = [
        (bid, ctx.doc.text(bid) or "", text or "(removed)")
        for bid, text in sorted(replaced.items())
        if _squash(text) != _squash(ctx.doc.text(bid) or "")
    ]
    user = rescore_prompt(posting, base_plain, tailored_plain, changes)
    completion = provider.complete(ctx._request("rescore", user, RescoreReply, 6000), on_delta)
    reply: RescoreReply = completion.data
    changed_ids = {bid for bid, _old, _new in changes}
    result = Rescore(
        base=ScoreCard.of(reply.base_ats_score, reply.base_hiring_manager_score),
        tailored=ScoreCard.of(reply.tailored_ats_score, reply.tailored_hiring_manager_score),
        verdict=reply.verdict,
        # Effects for bullets that didn't change are noise, so they're dropped.
        changes=[
            ChangeResult(bullet_id=c.bullet_id, effect=c.effect, reason=c.reason)
            for c in reply.changes
            if c.bullet_id in changed_ids
        ],
        scored=dict(replaced),
    )
    return result, step_stats("rescore", completion)


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
