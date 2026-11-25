"""The tailoring steps, run one after another:

1. Score: the base resume's ATS score out of 100 and the top 3 red flags a
   recruiter spots in ten seconds. Kept small, so it comes back fast.
2. Rewrite: the Experience and Projects bullets and the Technical Skills lines
   that a red flag or a missing keyword calls for, each citing its sources.
   Every other line is left alone.
3. Done: the base and the tailored resume scored side by side in one call, so
   the before and after numbers come from the same reading.

Every model call asks for JSON that matches a schema, and every proposed bullet
goes through the grounding check, the style rules and the specifics check
before the user can accept it. There is no summary step, and no way to add a
summary section.
"""

from __future__ import annotations

import re

from pydantic import BaseModel

from app.core import grounding, skills, style
from app.core.bold import keep_bold, strip_bold
from app.core.facts import FactsBank
from app.core.grounding import GroundingReport, Source
from app.core.schemas import Proposal, RedFlag, RescoreReply, RewritesReply, ScoreReply
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
- Write plain text. No LaTeX, no emoji, and no Markdown except **bold** where a request allows it.
- Style: no em dashes, no lists of three added for rhythm, no "not X but Y" contrasts, none of the words leverage, seamless, robust, spearheaded, delve or synergy, no comparisons with the person's own earlier work, and no mentions of AI tools unless the original bullet already has them. Every number must make sense on its own.
- Be direct and specific. No compliments, no padding."""


# Shared by Score and Done, so the before and after numbers mean the same thing.
RUBRIC = (
    "Scoring rubric. Use it exactly, so scores can be compared: how many of the posting's required and preferred "
    "skills and terms appear on the resume, whether bullets show concrete, measurable results with the tools named, "
    "and whether job titles and section headings are standard and easy to parse."
)


def score_prompt(company: str, posting: str) -> str:
    named = f" ({company.strip()})" if company.strip() else ""
    return (
        f"Act as both an ATS filter and a senior recruiter for this exact company{named}. Read my resume the way you'd "
        "actually read it, skimming for reasons to say no.\n\n"
        f"{RUBRIC}\n\n"
        "Give me a match score out of 100 as the ATS would score it (`ats_score`), and the top 3 red flags a hiring "
        "manager spots in under 10 seconds (`red_flags`). Be brutally honest, with no compliments or padding. For each "
        "flag say in one short sentence why it hurts for this specific job, and which resume section it is in (use the "
        "section names from the resume). Also give the company name and the role title as written in the posting.\n\n"
        f"<job_posting>\n{posting.strip()}\n</job_posting>"
    )


def rewrite_prompt(
    posting: str,
    flags: list[RedFlag],
    keywords: list[tuple[str, str]],
    facts: str,
    bullets: list[tuple[str, str, str]],
    feedback: str,
    added: list[tuple[str, str]] = (),
) -> str:
    flags_text = "".join(f"{i}. {f.flag} ({f.section}): {f.why}\n" for i, f in enumerate(flags, 1)) or "(none)\n"
    keywords_text = "".join(f"- {k} (shown by {src})\n" for k, src in keywords) or "(none)\n"
    bullets_text = "".join(f"[{bid}] ({entry}) {text}\n" for bid, entry, text in bullets)
    added_text = "".join(f"[{fid}] {text}\n" for fid, text in added) or "(none)\n"
    return (
        "Rewrite my experience section to kill those red flags. Lead every line with measurable impact using the "
        "Google XYZ formula and strip out every generic phrase. Write plainly and professionally.\n\n"
        "Only change a bullet if one of the red flags or missing keywords below calls for it. Return every other "
        "bullet unchanged. Never make a bullet less specific or less technical: keep every tool, number, name and "
        "detail it already has. A program checks this and blocks a rewrite that drops one.\n\n"
        f"Red flags:\n{flags_text}\n"
        f"Keywords from the posting that I can back up but don't show:\n{keywords_text}\n"
        f"Facts I added for this posting. Each one is true and you may use it; cite its id:\n{added_text}\n"
        "Lines with an id like [s1] are lines of my Technical Skills section: a comma-separated list under the "
        "label in parentheses. To show a skill I have but don't list, add it to the line where it fits, keep every "
        "skill already there, and cite the fact or bullet that backs it up. Don't add sentences to a skills line.\n\n"
        "Return one entry per bullet id, in the same order. For each:\n"
        "- `new_text`: the bullet, rewritten or unchanged. Only use numbers that appear in the cited sources. Keep "
        "roughly the same length so the resume stays one page. Bold is written **like this**. Keep a phrase bold if "
        "it was bold and is still in the bullet. You may bold the one short phrase that states the key result, "
        "using only words already in the original bullet. No other Markdown.\n"
        "- `sources`: the ids you drew on, always including the bullet's own id, plus any facts-bank ids (f1, f2, ...) "
        "you used.\n"
        "- `why`: a few words on which red flag or keyword this fixes, or empty if unchanged.\n\n"
        f"<bullets>\n{bullets_text}</bullets>\n\n"
        f"<facts_bank>\n{facts}\n</facts_bank>\n"
        f"{feedback}\n"
        f"<job_posting>\n{posting.strip()}\n</job_posting>"
    )


def rescore_prompt(posting: str, base_plain: str, tailored_plain: str) -> str:
    return (
        "Act as an ATS filter. Score two versions of my resume for this job in this one reply, with the same rubric, "
        "so the comparison is fair: <resume_a> is the base resume and <resume_b> is the tailored one.\n\n"
        f"{RUBRIC}\n\n"
        "Give the score out of 100 for each: `base_ats_score` for resume A and `tailored_ats_score` for resume B.\n\n"
        f"<resume_a>\n{base_plain}\n</resume_a>\n\n"
        f"<resume_b>\n{tailored_plain}\n</resume_b>\n\n"
        f"<job_posting>\n{posting.strip()}\n</job_posting>"
    )


RETRY_FEEDBACK = (
    "\nYour previous rewrites of these bullets were blocked by the checker. Fix each one using only what the sources "
    "support, or return the original text:\n{lines}\n"
)

NO_EDIT_FEEDBACK = (
    "\nYour previous answer returned these lines with the same text, so nothing changed. These advice items still "
    "need a change. Address each one in the line it belongs to, using only what the sources support. A line returned "
    "unchanged counts as no edit.\n{items}\n"
)

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

OK = "ok"  # every claim is backed up, so it can be accepted (style warnings may remain)
BLOCKED = "blocked"  # a number, name or skill isn't backed up, so it can't be accepted until fixed
UNCHANGED = "unchanged"  # same text as the original

# Why a line came back unchanged.
SAME_TEXT = "same_text"  # the model returned the original text
SKIPPED = "skipped"  # the model returned nothing for the line
BOLD_ONLY = "bold_only"  # only the bold changed, so the original was kept
REORDER_ONLY = "reorder_only"  # a skills line with the same skills in a new order


class CheckedRewrite(BaseModel):
    """A proposed rewrite after the code checks."""

    bullet_id: str
    entry: str
    section: str
    old_text: str
    new_text: str
    sources: list[str]
    why: str
    status: str
    grounding: GroundingReport
    style: list[Violation]
    # Why it's blocked: claims the sources don't back up. Empty when it isn't blocked.
    reasons: list[str]
    # Numbers, names and skills in the original that the rewrite left out.
    dropped: list[str] = []
    # Style findings and dropped details. Shown next to the rewrite; they never block it.
    warnings: list[str] = []
    # For an unchanged line: SAME_TEXT, SKIPPED, BOLD_ONLY or REORDER_ONLY.
    unchanged_reason: str = ""


class RewriteSummary(BaseModel):
    """What the rewrite step did, so the interface can say why nothing changed."""

    lines: int = 0
    changed: int = 0
    blocked: int = 0
    same_text: int = 0
    skipped: int = 0
    bold_only: int = 0
    reorder_only: int = 0
    # Ids the model answered for that aren't lines Tailor can edit.
    unknown_ids: list[str] = []
    # Whether the model was asked a second time, and why that call failed if it did.
    retried: bool = False
    retry_error: str = ""
    # Whether the score gave any advice (red flags or missing keywords) to act on.
    had_advice: bool = True
    # The reasons blocked rewrites were blocked, most common first.
    block_reasons: list[str] = []
    message: str = ""


class ScoreResult(BaseModel):
    company: str = ""
    role: str = ""
    # The base resume's ATS score out of 100.
    ats: int
    red_flags: list[RedFlag] = []


class FinalScore(BaseModel):
    """The base and tailored resume, scored in one reply."""

    before: int
    after: int
    # The bullet texts that were scored, so the interface can tell when a
    # decision made afterwards has made the score out of date.
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


def dropped_specifics(old_text: str, new_text: str) -> list[str]:
    """Numbers, names and skills in the original bullet that the rewrite leaves out.

    The grounding check, run the other way round: the original is the text
    being checked and the rewrite is its only source. A rewrite may add detail
    from its sources, but it may not lose any.
    """
    report = grounding.check(old_text, [Source(id="rewrite", text=new_text)])
    out: list[str] = []
    for claim in report.unsupported():
        if claim.text not in out:
            out.append(claim.text)
    return out


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
            lines.append(f"{tex_to_plain(label) or label}: {replaced.get(slot.id) or doc.text(slot.id) or ''}")
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

    def skills_label(self, slot_id: str) -> str:
        slot = self.doc.slot(slot_id)
        label = (slot.label or "") if slot is not None else ""
        return tex_to_plain(label) or label

    def editable_skills_lines(self) -> list:
        """Skills lines the rewrite may add to. An honors or awards line is left alone."""
        out = []
        for slot in self.doc.skills_lines():
            label = self.skills_label(slot.id).lower()
            if "honor" not in label and "award" not in label:
                out.append(slot)
        return out

    def rewrite_targets(self) -> list[tuple[str, str, str]]:
        """(id, heading, text) for every line the rewrite step covers.

        The Experience and Projects bullets, with their role or project as the
        heading, then the Technical Skills lines, with "Section | Label".
        """
        out = []
        for b in self.doc.bullets_in(REWRITE_SECTIONS):
            entry = self.doc.entry_title(b.entry) if b.entry is not None else ""
            out.append((b.id, entry, self.doc.text(b.id) or ""))
        for slot in self.editable_skills_lines():
            out.append((slot.id, f"{slot.section} | {self.skills_label(slot.id)}", self.doc.text(slot.id) or ""))
        return out

    def sources_for(self, bullet_id: str, cited: list[str], facts: FactsBank) -> list[Source]:
        """The cited lines and facts, plus the heading of the bullet's own role or project."""
        sources = []
        for sid in cited:
            fact = facts.get(sid)
            slot = self.doc.slot(sid)
            if fact is not None:
                sources.append(Source(id=sid, text=fact.text))
            elif slot is not None and slot.kind in (BULLET, SKILLS_LINE):
                sources.append(Source(id=sid, text=self.doc.text(sid) or ""))
        own = self.doc.slot(bullet_id)
        if own is not None and own.entry is not None:
            sources.append(Source(id="heading", text=self.doc.entry_title(own.entry)))
        return sources

    def check(
        self, proposal: Proposal, facts: FactsBank, added: list[str] | tuple[str, ...] = ()
    ) -> CheckedRewrite | None:
        """Run the code checks on one proposal. None if it doesn't point at a line the rewrite may change.

        ``added`` holds the ids of facts the person added for this run (the
        "Anything to add?" note). They count as sources whether or not the
        model cited them, and one that backs up a claim is added to the
        rewrite's sources so the card shows it.
        """
        slot = self.doc.slot(proposal.bullet_id)
        if slot is None or slot.kind not in (BULLET, SKILLS_LINE):
            return None
        is_skills = slot.kind == SKILLS_LINE
        if is_skills and slot.id not in {s.id for s in self.editable_skills_lines()}:
            return None
        old_text = self.doc.text(proposal.bullet_id) or ""
        # Keep the template's bold, and only the new bold the rules allow.
        new_text = keep_bold(old_text, clean_model_text(proposal.new_text))
        plain_new = strip_bold(new_text)
        plain_old = strip_bold(old_text)
        cited = [s.strip() for s in proposal.sources]
        # A rewrite always draws on its own line; add it if the model forgot.
        if proposal.bullet_id not in cited:
            cited.insert(0, proposal.bullet_id)
        extra = [fid for fid in added if fid not in cited and facts.get(fid) is not None]
        sources = self.sources_for(proposal.bullet_id, cited + extra, facts)
        sources = [Source(id=x.id, text=strip_bold(x.text)) for x in sources]
        source_texts = [x.text for x in sources if x.id != "heading"]
        report = grounding.check(plain_new, sources)
        # Show a fact from the note as a source when it backs up a claim.
        lex = skills.lexicon()
        for fid in extra:
            text = facts.get(fid).text
            if any(
                c.supported and (lex.contains(text, c.text) if c.kind == grounding.SKILL else c.text.lower() in text.lower())
                for c in report.claims
            ):
                cited.append(fid)
        # A skills line is a list, so the sentence style rules don't apply to it.
        violations = [] if is_skills else style.check_bullet(plain_new, source_texts)
        dropped = dropped_specifics(plain_old, plain_new)
        # Only a claim the sources don't back up blocks a rewrite. Style and lost
        # detail are the person's call, so they show as warnings.
        reasons = report.reasons()
        warnings = [f"{style.LABELS[v.rule]}: {v.message}" for v in violations] + [
            f'Drops "{d}" from the original.' for d in dropped
        ]
        unchanged_reason = ""
        if _squash(new_text) == _squash(old_text):
            status, unchanged_reason = UNCHANGED, SAME_TEXT
        elif _squash(plain_new) == _squash(plain_old):
            # Only the bold changed. Not worth a rewrite: keep the original.
            new_text = old_text
            status, unchanged_reason = UNCHANGED, BOLD_ONLY
        elif is_skills and sorted(_squash(x) for x in split_skills(plain_new)) == sorted(
            _squash(x) for x in split_skills(plain_old)
        ):
            # Same skills, new order. Export already puts the posting's skills first.
            new_text = old_text
            status, unchanged_reason = UNCHANGED, REORDER_ONLY
        elif report.ok():
            status = OK
        else:
            status = BLOCKED
        if status == UNCHANGED:
            # Nothing changes, so nothing is claimed, lost or worth a warning.
            report, reasons, warnings, dropped, violations = GroundingReport(), [], [], [], []
        return CheckedRewrite(
            bullet_id=proposal.bullet_id,
            entry=self.doc.entry_title(slot.entry) if slot.entry is not None else (
                f"{slot.section} | {self.skills_label(slot.id)}" if is_skills else ""
            ),
            section=slot.section,
            old_text=old_text,
            new_text=new_text,
            sources=cited,
            why=proposal.why,
            status=status,
            grounding=report,
            style=violations,
            reasons=reasons,
            dropped=dropped,
            warnings=warnings,
            unchanged_reason=unchanged_reason,
        )

    def check_all(
        self,
        proposals: list[Proposal],
        facts: FactsBank,
        targets: list[tuple[str, str, str]],
        added: list[str] | tuple[str, ...] = (),
    ) -> list[CheckedRewrite]:
        """One checked result per target line, in target order.

        The first proposal for each line is used. A line the model skipped
        comes back unchanged, marked SKIPPED.
        """
        out = []
        for bid, _entry, text in targets:
            proposal = next((p for p in proposals if p.bullet_id == bid), None)
            missing = proposal is None
            if missing:
                proposal = Proposal(bullet_id=bid, new_text=text, sources=[bid], why="")
            checked = self.check(proposal, facts, added)
            if checked is not None:
                if missing:
                    checked.unchanged_reason = SKIPPED
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


def score(
    provider: Provider, ctx: Context, company: str, posting: str, on_delta: DeltaSink = ignore_deltas
) -> tuple[ScoreResult, StepStats]:
    """The base resume's ATS score and top 3 red flags. The facts bank isn't sent: the score is of the page."""
    request = ctx._request("score", score_prompt(company, posting), ScoreReply, 1500)
    completion = provider.complete(request, on_delta)
    reply: ScoreReply = completion.data
    result = ScoreResult(
        company=reply.company,
        role=reply.role,
        ats=_clamp(reply.ats_score),
        # A flag that says to add a summary is dropped: the resume never gets one.
        red_flags=[f for f in reply.red_flags if not _asks_for_summary(f)][:3],
    )
    return result, step_stats("score", completion)


def advice_items(flags: list[RedFlag], keywords: list[tuple[str, str]]) -> list[str]:
    """The score's advice as a numbered list, for the second try when the first changed nothing."""
    items = [f"{f.flag} ({f.section}): {f.why}" for f in flags]
    items += [
        f"Show {k}, backed up by {src}"
        + (". Add it to the skills line where it fits." if src != "base resume" else ".")
        for k, src in keywords
    ]
    return [f"{i}. {item}" for i, item in enumerate(items, 1)]


def unaddressed_keywords(checked: list[CheckedRewrite], keywords: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Missing keywords that no accepted-quality rewrite adds."""
    lex = skills.lexicon()
    shown = " \n ".join(strip_bold(r.new_text) for r in checked if r.status == OK)
    return [(k, src) for k, src in keywords if not lex.contains(shown, k)]


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def summarize(
    checked: list[CheckedRewrite], had_advice: bool, unknown_ids: list[str], retried: bool, retry_error: str
) -> RewriteSummary:
    """Count what happened to each line and say it in one or two sentences."""
    summary = RewriteSummary(
        lines=len(checked),
        changed=sum(1 for r in checked if r.status == OK),
        blocked=sum(1 for r in checked if r.status == BLOCKED),
        same_text=sum(1 for r in checked if r.unchanged_reason == SAME_TEXT),
        skipped=sum(1 for r in checked if r.unchanged_reason == SKIPPED),
        bold_only=sum(1 for r in checked if r.unchanged_reason == BOLD_ONLY),
        reorder_only=sum(1 for r in checked if r.unchanged_reason == REORDER_ONLY),
        unknown_ids=unknown_ids,
        retried=retried,
        retry_error=retry_error,
        had_advice=had_advice,
    )
    counts: dict[str, int] = {}
    for r in checked:
        if r.status == BLOCKED:
            for reason in r.reasons:
                counts[reason] = counts.get(reason, 0) + 1
    summary.block_reasons = sorted(counts, key=lambda k: -counts[k])

    parts: list[str] = []
    if summary.changed == 0 and summary.blocked == 0:
        if not had_advice:
            parts.append("No changes needed: the score found nothing for the rewrite to fix.")
        else:
            tries = "after a second try that listed the advice" if retried else "on the first try"
            parts.append(f"The model returned every line unchanged {tries}, so there is nothing to review.")
    if summary.blocked:
        reasons = " ".join(summary.block_reasons[:2])
        parts.append(
            f"{_plural(summary.blocked, 'rewrite was', 'rewrites were')} blocked because the sources don't back "
            f"up every claim. {reasons}".strip()
        )
    if summary.bold_only:
        parts.append(f"{_plural(summary.bold_only, 'rewrite')} only changed bold, so the original was kept.")
    if summary.reorder_only:
        parts.append(
            f"{_plural(summary.reorder_only, 'skills line')} only changed order; export already puts the "
            "posting's skills first."
        )
    if unknown_ids:
        parts.append(
            f"{_plural(len(unknown_ids), 'answer')} pointed at lines Tailor can't edit ({', '.join(unknown_ids[:5])})."
        )
    if retry_error:
        parts.append(f"The second try failed: {retry_error}")
    summary.message = " ".join(parts)
    return summary


def rewrite(
    provider: Provider,
    ctx: Context,
    posting: str,
    flags: list[RedFlag],
    keywords: list[tuple[str, str]],
    facts: FactsBank,
    on_delta: DeltaSink = ignore_deltas,
    added: list[str] | tuple[str, ...] = (),
) -> tuple[list[CheckedRewrite], list[StepStats], RewriteSummary]:
    """Rewrite the lines the red flags and missing keywords call for, and check each one.

    ``keywords`` holds (skill, where it's backed up) for the posting's skills
    the person has but doesn't show. ``added`` holds the ids of facts the
    person added for this run; they are listed in the prompt and count as
    sources in the check.

    The model gets one second try, for two reasons. Rewrites that are blocked
    or have warnings go back with the checker's findings, and a retry
    replaces one only when it isn't blocked and has fewer warnings. And when
    the first answer changed nothing, or added none of the missing keywords,
    the unchanged lines go back with the advice it has to address. A line
    returned with its original text counts as no edit.
    """
    targets = ctx.rewrite_targets()
    target_ids = {t[0] for t in targets}
    facts_text = facts_prompt_text(facts)
    added_facts = [(fid, facts.get(fid).text) for fid in added if facts.get(fid) is not None]
    user = rewrite_prompt(posting, flags, keywords, facts_text, targets, "", added_facts)
    completion = provider.complete(ctx._request("rewrite", user, RewritesReply, 16000), on_delta)
    proposals = completion.data.rewrites
    unknown = [p.bullet_id for p in proposals if p.bullet_id not in target_ids]
    checked = ctx.check_all(proposals, facts, targets, added)
    stats = [step_stats("rewrite", completion, checked)]
    had_advice = bool(flags or keywords)

    to_fix = [r for r in checked if r.status == BLOCKED or (r.status == OK and r.warnings)]
    no_edits = not any(r.status in (OK, BLOCKED) for r in checked)
    missed = unaddressed_keywords(checked, keywords)
    unchanged = [r for r in checked if r.status == UNCHANGED] if had_advice and (no_edits or missed) else []
    if not to_fix and not unchanged:
        return checked, stats, summarize(checked, had_advice, unknown, False, "")

    feedback = ""
    if to_fix:
        lines = "\n".join(f'[{r.bullet_id}] "{r.new_text}": {" ".join(r.reasons + r.warnings)}' for r in to_fix)
        feedback += RETRY_FEEDBACK.format(lines=lines)
    if unchanged:
        items = advice_items(flags, missed if not no_edits else keywords)
        feedback += NO_EDIT_FEEDBACK.format(items="\n".join(items))
    retry_ids = {r.bullet_id for r in to_fix + unchanged}
    retry_targets = [t for t in targets if t[0] in retry_ids]
    user = rewrite_prompt(posting, flags, keywords, facts_text, retry_targets, feedback, added_facts)
    try:
        retry = provider.complete(ctx._request("rewrite_retry", user, RewritesReply, 16000), on_delta)
    except ProviderError as e:
        # The first attempt already gave a full result; a failed retry leaves it as is.
        return checked, stats, summarize(checked, had_advice, unknown, True, str(e) or e.kind)
    retry_proposals = retry.data.rewrites
    unknown += [p.bullet_id for p in retry_proposals if p.bullet_id not in target_ids and p.bullet_id not in unknown]
    retried = ctx.check_all(retry_proposals, facts, retry_targets, added)
    stats.append(step_stats("rewrite_retry", retry, retried))
    by_id = {r.bullet_id: r for r in retried}

    def better(first: CheckedRewrite) -> CheckedRewrite:
        second = by_id.get(first.bullet_id)
        if second is None:
            return first
        if first.status == UNCHANGED:
            # A real edit on the second try replaces no edit. A blocked one is shown too, so the
            # person sees why the advice couldn't be followed.
            return second if second.status != UNCHANGED else first
        if second.status == BLOCKED:
            return first
        if first.status == BLOCKED or len(second.warnings) < len(first.warnings):
            return second
        return first

    final = [better(r) for r in checked]
    return final, stats, summarize(final, had_advice, unknown, True, "")


def rescore(
    provider: Provider,
    ctx: Context,
    posting: str,
    replaced: dict[str, str],
    on_delta: DeltaSink = ignore_deltas,
) -> tuple[FinalScore, StepStats]:
    """Score the base resume and the current one (``replaced`` holds the accepted
    changes) in a single call.

    Two separate calls would each carry their own run-to-run noise, so a small
    gain could show up as a loss. One call scores both with the same reading.
    """
    base_plain = resume_plain(ctx.doc, {}, with_ids=False)
    tailored_plain = resume_plain(ctx.doc, replaced, with_ids=False)
    user = rescore_prompt(posting, base_plain, tailored_plain)
    completion = provider.complete(ctx._request("rescore", user, RescoreReply, 800), on_delta)
    reply: RescoreReply = completion.data
    result = FinalScore(
        before=_clamp(reply.base_ats_score), after=_clamp(reply.tailored_ats_score), scored=dict(replaced)
    )
    return result, step_stats("rescore", completion)


# ---------------------------------------------------------------------------
# The note under Score: "Anything to add?"
# ---------------------------------------------------------------------------

# A sentence ends at . ! or ? followed by a space, so "Node.js" and "v2.1" stay
# whole. Notes are typed quickly, so the next sentence may start in lowercase.
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


# A note that asks for a skill to be shown: "add Node.js", "please include C# and Docker".
_ASKS_TO_ADD = re.compile(r"^(?:please\s+)?(?:add|include|mention|list|show|put)\b", re.IGNORECASE)


def split_note(note: str) -> list[str]:
    """Split a free-text note into short facts: one per line, list item or sentence.

    A note that asks for skills to be added ("add Node.js to my skills") is
    saved as the skills it names ("Skills: Node.js"), since that's the fact
    it states. Any other fragment of fewer than three words is kept only when
    it names a skill ("Node.js, Redis"); otherwise it carries no fact on its
    own and is left out. A final period is dropped, as in the facts bank.
    """
    lex = skills.lexicon()
    facts: list[str] = []
    for line in note.splitlines():
        line = line.strip().lstrip("-*•·").strip()
        for piece in _SENTENCE_END.split(line):
            piece = " ".join(piece.split()).rstrip(".")
            named = lex.find(piece)
            if named and _ASKS_TO_ADD.match(piece):
                piece = "Skills: " + ", ".join(named)
            elif len(piece.split()) < 3 and not named:
                continue
            if piece and piece not in facts:
                facts.append(piece)
    return facts


# ---------------------------------------------------------------------------
# Counted in code: coverage, skills order, export edits, trimming
# ---------------------------------------------------------------------------


def coverage_for(
    ctx: Context, posting_skills: skills.PostingSkills, replaced: dict[str, str], facts: FactsBank
) -> skills.Coverage:
    base = resume_plain(ctx.doc, {}, with_ids=False)
    current = resume_plain(ctx.doc, replaced, with_ids=False)
    return skills.coverage(posting_skills, current, base, [(f.id, f.text) for f in facts.facts])


def skills_reorder_edits(
    doc: TexDoc, posting: skills.PostingSkills, texts: dict[str, str] | None = None
) -> list[ReorderSkills | SetText]:
    """Move the posting's skills to the front of each skills line.

    Required matches first, then preferred, then other mentions, then the rest
    in their original order. Only reorders: no skill is added or dropped. An
    honors or awards line is left alone. ``texts`` holds accepted rewrites of
    skills lines (which may add a skill); those lines are written from it.
    """
    lex = skills.lexicon()

    def rank(item: str) -> int:
        found = lex.find(item)
        for i, tier in enumerate((posting.required, posting.preferred, posting.mentioned)):
            if any(s in tier for s in found):
                return i
        return 3

    edits: list[ReorderSkills | SetText] = []
    for slot in doc.skills_lines():
        label = (slot.label or "").lower()
        if "honor" in label or "award" in label:
            continue
        if slot.id in (texts or {}):
            # An accepted rewrite of the line: write its text, in the same order.
            items = split_skills(texts[slot.id])
            edits.append(SetText(slot=slot.id, text=", ".join(sorted(items, key=rank))))
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
    lines = {s.id for s in doc.skills_lines()}
    skills_texts = {bid: text for bid, text in accepted.items() if bid in lines}
    edits: list = [
        SetText(slot=bid, text=text)
        for bid, text in sorted(accepted.items())
        if bid not in removed and (bid not in lines or posting is None)
    ]
    edits += [Remove(slot=bid) for bid in removed]
    if posting is not None:
        edits += skills_reorder_edits(doc, posting, skills_texts)
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
