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
from app.core.instructions import ADD, ADD_BULLET, ASK, CHANGE, NOT_FOUND, Instruction, parse_instructions
from app.core.lines import BULLET_LINE, SKILLS, Line, protected_changes, resume_lines
from app.core.schemas import ItemReport, Proposal, RedFlag, RescoreReply, RewritesReply, ScoreReply
from app.core.style import Violation
from app.core.tex import BULLET, SKILLS_LINE, AddBullet, Remove, ReorderSkills, SetText, TexDoc, split_skills, tex_to_plain
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
    advice: list[tuple[str, str]],
    notes: list[tuple[str, str]],
    facts: str,
    lines: list[tuple[str, str, str]],
    feedback: str,
    protected: list[tuple[str, list[str]]] = (),
    asked: list[str] = (),
) -> str:
    """The rewrite request.

    ``advice`` and ``notes`` are (item id, text): the score's red flags and
    missing keywords, then the facts the person added for this posting. The
    model works through them in that order, then makes its own obvious
    improvements, and reports on every item.
    """
    advice_text = "".join(f"[{iid}] {text}\n" for iid, text in advice) or "(none)\n"
    notes_text = "".join(f"[{iid}] {text}\n" for iid, text in notes) or "(none)\n"
    lines_text = "".join(f"[{lid}] ({where}) {text}\n" for lid, where, text in lines)
    protected_text = "".join(f"[{lid}] " + "; ".join(f'"{p}"' for p in keep) + "\n" for lid, keep in protected if keep)
    asked_text = "".join(f"- {a}\n" for a in asked)
    return (
        "Rewrite my experience section to kill those red flags. Treat the rest of my resume the same way. "
        "Work through these, in this order:\n"
        "1. Every advice item from the score.\n"
        "2. Every note I added.\n"
        "3. Then the obvious improvements you find yourself: a weak or vague verb, a redundant phrase, a keyword "
        "from the posting that my resume or facts back up but don't show, a number I've already given that a line "
        "leaves out.\n"
        "Lead every line with measurable impact using the Google XYZ formula and strip out every generic phrase. "
        "Write plainly and professionally. Return any line that none of these call for unchanged. Never make a line "
        "less specific or less technical: keep every tool, number, name and detail it already has. A program checks "
        "this and blocks a rewrite that drops one.\n\n"
        f"Advice from the score:\n{advice_text}\n"
        f"Notes I added for this posting. Each one is true and you may use it; cite its fact id:\n{notes_text}\n"
        + (f"Changes I asked for, already made by the app. Leave those lines alone:\n{asked_text}\n" if asked else "")
        + "The lines below are every line you may change. Ids like [s1] are Technical Skills lines: a comma-separated "
        "list under the label in parentheses. To show a skill I have but don't list, add it to the line where it "
        "fits, keep every skill already there, and cite the fact or line that backs it up. Don't add sentences to a "
        "list. A project heading is its name, then \"|\", then its tech stack; only the stack may change.\n\n"
        "Protected facts: dates, GPA, school, degree, employer, job title, location, and an honor's name and its "
        "numbers. Keep these word for word. A program blocks any change to them that I didn't ask for:\n"
        f"{protected_text or '(none)'}\n\n"
        "Return:\n"
        "- `rewrites`: one entry per line id, in the same order. `new_text`: the line, rewritten or unchanged. "
        "Only use numbers that appear in the cited sources. Keep roughly the same length so the resume stays one "
        "page. Bold is written **like this**. Keep a phrase bold if it was bold and is still in the line. You may "
        "bold the one short phrase that states the key result, using only words already in the original line. No "
        "other Markdown. `sources`: the ids you drew on, always including the line's own id, plus any facts-bank "
        "ids (f1, f2, ...) you used. `why`: a few words on which item this addresses, or empty if unchanged.\n"
        "- `items`: one entry per advice item and note id, in order. `item_id`; `applied`: true only if a line you "
        "changed addresses it; `line_ids`: the ids you changed for it; `why`: one short sentence, what you changed, "
        "or why no line could address it with what my resume and facts back up.\n\n"
        f"<lines>\n{lines_text}</lines>\n\n"
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
    "\nYour previous answer returned these lines with the same text, so nothing changed. That counts as a failed "
    "attempt. Work through this checklist: address each item in the line it belongs to, using only what the sources "
    "support, and report on each one in `items`. A line returned unchanged counts as no edit.\n{items}\n"
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
    # What the line is ("Bullet", "Graduation date", "Tech stack").
    label: str = ""
    # The note that asked for this change, when the person asked for it.
    asked: str = ""
    # "add" when the note added something ("add C++"), "change" when it changed it; "edit" for a hand edit.
    asked_kind: str = ""


# Outcome of one advice item or note.
APPLIED = "applied"
ITEM_BLOCKED = "blocked"
COULDNT_ACT = "couldnt_act"
ASKED = "ask"  # a note that could mean more than one line: the person is asked which


class ItemResult(BaseModel):
    """What the rewrite did with one advice item from the score or one note."""

    id: str
    # "advice" or "note".
    kind: str
    text: str
    status: str
    # The lines it changed, or the lines a note could mean.
    lines: list[str] = []
    why: str = ""


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
    # Model changes to protected facts that no note asked for, all blocked.
    protected_blocked: int = 0
    # Lines changed because a note asked for it.
    asked: int = 0
    # One result per advice item and note, advice first.
    items: list[ItemResult] = []
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
    # Only a bullet mark followed by a space: "**Bold** start" keeps its bold.
    t = re.sub(r"^[-*•]\s+", "", s.strip()).strip()
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


def _entry_title(doc: TexDoc, entry: int, replaced: dict[str, str]) -> str:
    """``doc.entry_title`` with any changed heading fields."""
    if not any(f in replaced for f in doc.entries[entry].fields):
        return doc.entry_title(entry)
    e = doc.entries[entry]
    picks = [0, 2] if e.kind == "subheading" else [0]
    parts = [replaced.get(e.fields[k]) or doc.text(e.fields[k]) for k in picks if k < len(e.fields)]
    return " | ".join(p for p in parts if p)


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
                lines.append(f"### {_entry_title(doc, slot.entry, replaced)}")
                last_entry = slot.entry
            text = replaced.get(slot.id, doc.text(slot.id) or "")
            if text:
                lines.append(f"- [{slot.id}] {text}" if with_ids else f"- {text}")
            # Bullets added after this one (new:b5, new:b5:2), in order.
            for key in sorted(k for k in replaced if k == f"new:{slot.id}" or k.startswith(f"new:{slot.id}:")):
                if replaced[key]:
                    lines.append(f"- {replaced[key]}")
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
        self.lines = resume_lines(self.doc)
        self._lines = {line.id: line for line in self.lines}
        # Sent as the cached context on every call.
        self.base_plain = resume_plain(self.doc, {}, with_ids=True)

    def line(self, line_id: str) -> Line | None:
        return self._lines.get(line_id)

    def rewrite_targets(self, leave: set[str] | frozenset[str] = frozenset()) -> list[tuple[str, str, str]]:
        """(id, heading, text) for every line the model may change on its own, in page order.

        Bullets in every section (coursework and honors included), skills
        lines and project tech stacks. Lines in ``leave`` (ones a note already
        changed) aren't sent.
        """
        return [(ln.id, ln.heading, ln.text) for ln in self.lines if ln.editable and ln.id not in leave]

    def protected_parts(self, ids: list[str]) -> list[tuple[str, list[str]]]:
        """The protected pieces of the given lines, for the prompt."""
        return [(i, self._lines[i].protected) for i in ids if i in self._lines and self._lines[i].protected]

    def sources_for(self, bullet_id: str, cited: list[str], facts: FactsBank) -> list[Source]:
        """The cited lines and facts, plus the heading of the line's own role or project."""
        sources = []
        for sid in cited:
            fact = facts.get(sid)
            line = self._lines.get(sid)
            if fact is not None:
                sources.append(Source(id=sid, text=fact.text))
            elif line is not None:
                sources.append(Source(id=sid, text=line.text))
        own = self.doc.slot(bullet_id)
        if own is not None and own.entry is not None:
            sources.append(Source(id="heading", text=self.doc.entry_title(own.entry)))
        return sources

    def check(
        self,
        proposal: Proposal,
        facts: FactsBank,
        added: list[str] | tuple[str, ...] = (),
        asked: str = "",
    ) -> CheckedRewrite | None:
        """Run the code checks on one proposal. None if it doesn't point at a line of the resume.

        ``added`` holds the ids of facts the person added for this run (the
        "Anything to add?" note). They count as sources whether or not the
        model cited them, and one that backs up a claim is added to the
        rewrite's sources so the card shows it.

        ``asked`` is the note that asked for this change, when the person asked
        for it. The note is then a source, and the change may touch a
        protected fact. Without it, any change to a protected fact (a date, a
        GPA, an employer, an honor's numbers) is blocked.
        """
        line = self._lines.get(proposal.bullet_id)
        if line is None:
            return None
        is_list = line.kind == SKILLS
        old_text = line.text
        # Keep the template's bold, and only the new bold the rules allow.
        new_text = keep_bold(old_text, proposal.new_text if asked else clean_model_text(proposal.new_text))
        plain_new = strip_bold(new_text)
        plain_old = strip_bold(old_text)
        cited = [s.strip() for s in proposal.sources]
        # A rewrite always draws on its own line; add it if the model forgot.
        if proposal.bullet_id not in cited:
            cited.insert(0, proposal.bullet_id)
        extra = [fid for fid in added if fid not in cited and facts.get(fid) is not None]
        sources = self.sources_for(proposal.bullet_id, cited + extra, facts)
        if asked:
            sources.append(Source(id="note", text=asked))
            cited.append("note")
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
        # Only a bullet is a sentence; the style rules don't apply to lists, headings or honors.
        violations = style.check_bullet(plain_new, source_texts) if line.kind == BULLET_LINE and not asked else []
        dropped = [] if asked else dropped_specifics(plain_old, plain_new)
        # A claim the sources don't back up blocks a rewrite, and so does a change to a protected
        # fact that the person didn't ask for. Style and lost detail are the person's call, so
        # they show as warnings.
        reasons = [] if asked else report.reasons()
        touched = [] if asked else protected_changes(line, plain_new)
        reasons += [
            f'Changes "{p}", a protected fact ({line.label.lower()}). Only a note that asks for it can change it.'
            for p in touched
        ]
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
        elif is_list and not asked and sorted(_squash(x) for x in split_skills(plain_new)) == sorted(
            _squash(x) for x in split_skills(plain_old)
        ):
            # Same skills, new order. Export already puts the posting's skills first.
            new_text = old_text
            status, unchanged_reason = UNCHANGED, REORDER_ONLY
        elif asked or (report.ok() and not touched):
            # A change the person asked for is theirs: it's never blocked, whatever the checks say.
            status = OK
        else:
            status = BLOCKED
        if status == UNCHANGED:
            # Nothing changes, so nothing is claimed, lost or worth a warning.
            report, reasons, warnings, dropped, violations = GroundingReport(), [], [], [], []
        return CheckedRewrite(
            bullet_id=proposal.bullet_id,
            entry=line.heading,
            section=line.section,
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
            label=line.label,
            asked=asked if status != UNCHANGED else "",
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


class Advice(BaseModel):
    """One advice item from the score: a red flag, or a missing keyword."""

    id: str
    text: str
    section: str = ""
    keyword: str = ""


def advice_list(flags: list[RedFlag], keywords: list[tuple[str, str]]) -> list[Advice]:
    """The score's red flags, then the missing keywords, numbered a1, a2, ..."""
    out = [Advice(id="", text=f"{f.flag} ({f.section}): {f.why}", section=f.section) for f in flags]
    out += [
        Advice(
            id="",
            text=f"Show {k}, backed up by {src}"
            + (". Add it to the line where it fits." if src != "base resume" else "."),
            keyword=k,
        )
        for k, src in keywords
    ]
    for i, a in enumerate(out, 1):
        a.id = f"a{i}"
    return out


def note_items(facts: FactsBank, added: list[str] | tuple[str, ...], asked: list[str]) -> list[tuple[str, str, str]]:
    """(item id, fact id or "", text) for each note: the facts it added, then the changes it asked for."""
    out = []
    for fid in added:
        fact = facts.get(fid)
        if fact is not None:
            out.append((f"n{len(out) + 1}", fid, fact.text))
    for note in asked:
        out.append((f"n{len(out) + 1}", "", note))
    return out


def unaddressed_keywords(checked: list[CheckedRewrite], keywords: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Missing keywords that no accepted-quality rewrite adds."""
    lex = skills.lexicon()
    shown = " \n ".join(strip_bold(r.new_text) for r in checked if r.status == OK)
    return [(k, src) for k, src in keywords if not lex.contains(shown, k)]


def apply_instructions(
    ctx: Context, notes: list[str], facts: FactsBank, added: list[str] | tuple[str, ...] = ()
) -> tuple[list[Instruction], list[CheckedRewrite]]:
    """Resolve each change the person asked for and apply it in code.

    Instructions are applied in order, each to the line as the ones before it
    left it, so two notes can change the same line. Each changed line is
    checked with its note as the source. Returns every instruction (including
    the ones that need the person to say which line) and the checked lines.
    """
    lines = [line.model_copy() for line in ctx.lines]
    by_id = {line.id: line for line in lines}
    asked_by: dict[str, list[str]] = {}
    resolved: list[Instruction] = []
    new_bullets: list[CheckedRewrite] = []
    for i, note in enumerate(notes, 1):
        for instruction in parse_instructions(f"n{i}", note, lines, canonical_skill):
            if instruction.kind == ADD_BULLET:
                # A new line after the entry's last bullet: new:b5, then new:b5:2 for a second one.
                taken = {r.bullet_id for r in new_bullets}
                bullet_id = instruction.line_id
                n = 2
                while bullet_id in taken:
                    bullet_id = f"{instruction.line_id}:{n}"
                    n += 1
                instruction.line_id = bullet_id
                anchor = ctx.line(bullet_id.split(":")[1])
                new_bullets.append(
                    CheckedRewrite(
                        bullet_id=bullet_id, entry=anchor.heading if anchor else "", section=anchor.section if anchor else "",
                        old_text="", new_text=clean_model_text(instruction.new_text), sources=["note"], why="You asked for it",
                        status=OK, grounding=GroundingReport(), style=[], reasons=[], label="New bullet",
                        asked=instruction.note, asked_kind="add",
                    )
                )
            resolved.append(instruction)
            if instruction.kind in (CHANGE, ADD):
                by_id[instruction.line_id].text = instruction.new_text
                asked_by.setdefault(instruction.line_id, []).append(instruction.note)
    kinds = {i.line_id: i.kind for i in resolved}
    checked = []
    for line_id, asked in asked_by.items():
        proposal = Proposal(bullet_id=line_id, new_text=by_id[line_id].text, sources=[line_id], why="You asked for it")
        result = ctx.check(proposal, facts, added, asked="; ".join(dict.fromkeys(asked)))
        if result is not None:
            result.asked_kind = "add" if kinds.get(line_id) == ADD else "change"
            checked.append(result)
    return resolved, checked + new_bullets


def canonical_skill(name: str) -> str | None:
    """A skill's usual spelling from the lexicon ("c++" is "C++"), or None for one it doesn't know."""
    found = skills.lexicon().find(name)
    return found[0] if len(found) == 1 else None


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def _section_matches(section: str, line_section: str) -> bool:
    a, b = section.strip().lower(), line_section.strip().lower()
    return bool(a) and (a in b or b in a or a.split()[0] == b.split()[0] if a and b else False)


def item_results(
    ctx: Context,
    final: list[CheckedRewrite],
    advice: list[Advice],
    notes: list[tuple[str, str, str]],
    instructions: list[Instruction],
    reports: dict[str, ItemReport],
) -> list[ItemResult]:
    """Applied, Blocked, Couldn't act or a question, for every advice item and note.

    Code decides where it can: a keyword is applied when a changed line now
    shows it, and a note's fact when a changed line cites it. A red flag
    relies on the model's report, checked against what happened to the lines
    it names. An item the model didn't report on says so.
    """
    by_id = {r.bullet_id: r for r in final}
    lex = skills.lexicon()
    out: list[ItemResult] = []

    def blocked_why(rows: list[CheckedRewrite]) -> str:
        return " ".join(dict.fromkeys(reason for r in rows for reason in r.reasons))

    def from_report(item_id: str, kind: str, text: str, fallback: str) -> ItemResult:
        report = reports.get(item_id)
        if report is None:
            return ItemResult(id=item_id, kind=kind, text=text, status=COULDNT_ACT, why=fallback)
        rows = [by_id[i] for i in report.line_ids if i in by_id]
        ok = [r.bullet_id for r in rows if r.status == OK]
        if report.applied and ok:
            return ItemResult(id=item_id, kind=kind, text=text, status=APPLIED, lines=ok, why=report.why)
        blocked = [r for r in rows if r.status == BLOCKED]
        if report.applied and blocked:
            return ItemResult(id=item_id, kind=kind, text=text, status=ITEM_BLOCKED,
                              lines=[r.bullet_id for r in blocked], why=blocked_why(blocked))
        if report.applied:
            why = f"The model said it changed {', '.join(report.line_ids) or 'a line'}, but nothing on the page changed."
            return ItemResult(id=item_id, kind=kind, text=text, status=COULDNT_ACT, why=why)
        return ItemResult(id=item_id, kind=kind, text=text, status=COULDNT_ACT,
                          why=report.why or "The model didn't say why.")

    editable_sections = {ln.section for ln in ctx.lines if ln.editable}
    for a in advice:
        if a.keyword:
            showing = [r for r in final if r.status == OK and lex.contains(strip_bold(r.new_text), a.keyword)
                       and not lex.contains(strip_bold(r.old_text), a.keyword)]
            if showing:
                out.append(ItemResult(id=a.id, kind="advice", text=a.text, status=APPLIED,
                                      lines=[r.bullet_id for r in showing], why=f"{a.keyword} is now on the page."))
                continue
            stuck = [r for r in final if r.status == BLOCKED and lex.contains(strip_bold(r.new_text), a.keyword)]
            if stuck:
                out.append(ItemResult(id=a.id, kind="advice", text=a.text, status=ITEM_BLOCKED,
                                      lines=[r.bullet_id for r in stuck], why=blocked_why(stuck)))
                continue
            result = from_report(a.id, "advice", a.text, f"No line shows {a.keyword} yet.")
            if result.status == APPLIED:  # the model says so, but the keyword isn't on any changed line
                result = ItemResult(id=a.id, kind="advice", text=a.text, status=COULDNT_ACT,
                                    why=f"No changed line shows {a.keyword}.")
            out.append(result)
            continue
        result = from_report(a.id, "advice", a.text, "The model didn't report on this item.")
        if result.status == COULDNT_ACT and a.section and not any(
            _section_matches(a.section, s) for s in editable_sections
        ):
            result.why = (
                f'There\'s no line in "{a.section}" that the rewrite can change, so this needs a change you make '
                "yourself or a note that says what to change."
            )
        out.append(result)

    asked_ids = {r.bullet_id for r in final if r.asked}
    instructions_by_note: dict[str, list[Instruction]] = {}
    for i in instructions:
        instructions_by_note.setdefault(i.note, []).append(i)
    for item_id, fid, text in notes:
        if fid:
            citing = [r for r in final if fid in r.sources]
            ok = [r.bullet_id for r in citing if r.status == OK]
            if ok:
                out.append(ItemResult(id=item_id, kind="note", text=text, status=APPLIED, lines=ok,
                                      why=reports[item_id].why if item_id in reports else ""))
                continue
            blocked = [r for r in citing if r.status == BLOCKED]
            if blocked:
                out.append(ItemResult(id=item_id, kind="note", text=text, status=ITEM_BLOCKED,
                                      lines=[r.bullet_id for r in blocked], why=blocked_why(blocked)))
                continue
            result = from_report(item_id, "note", text, "The model didn't use this note on any line.")
            if result.status == APPLIED:
                result.status, result.why = COULDNT_ACT, "No changed line uses this note."
            out.append(result)
            continue
        group = instructions_by_note.get(text)
        if not group:
            continue
        instruction = group[0]
        if instruction.kind in (CHANGE, ADD, ADD_BULLET):
            rows = [by_id[i.line_id] for i in group if i.line_id in by_id]
            done_rows = [r for r in rows if r.bullet_id in asked_ids and r.status == OK]
            if done_rows:
                what = "Added" if instruction.kind != CHANGE else "Changed"
                where = ", ".join(dict.fromkeys(r.label.lower() for r in done_rows))
                out.append(ItemResult(id=item_id, kind="note", text=text, status=APPLIED, lines=[r.bullet_id for r in done_rows],
                                      why=f"{what} as you asked ({where})."))
            else:
                out.append(ItemResult(id=item_id, kind="note", text=text, status=COULDNT_ACT,
                                      why="That line already says this, so nothing changed."))
        elif instruction.kind == ASK:
            out.append(ItemResult(id=item_id, kind="note", text=text, status=ASKED, lines=instruction.candidates,
                                  why=instruction.question))
        else:
            out.append(ItemResult(id=item_id, kind="note", text=text, status=COULDNT_ACT, why=instruction.question))
    return out


def summarize(
    checked: list[CheckedRewrite],
    had_advice: bool,
    unknown_ids: list[str],
    retried: bool,
    retry_error: str,
    items: list[ItemResult] = (),
) -> RewriteSummary:
    """Count what happened to each line and item, and say it in a sentence or two."""
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
        protected_blocked=sum(1 for r in checked if r.status == BLOCKED and any("protected fact" in x for x in r.reasons)),
        asked=sum(1 for r in checked if r.asked and r.status == OK),
        items=list(items),
    )
    counts: dict[str, int] = {}
    for r in checked:
        if r.status == BLOCKED:
            for reason in r.reasons:
                counts[reason] = counts.get(reason, 0) + 1
    summary.block_reasons = sorted(counts, key=lambda k: -counts[k])

    parts: list[str] = []
    model_changes = sum(1 for r in checked if r.status in (OK, BLOCKED) and not r.asked)
    if summary.changed == 0 and summary.blocked == 0:
        if not had_advice:
            parts.append("No changes needed: the score gave no advice and you added no notes.")
        else:
            tries = "after a second try with the advice and your notes as a checklist" if retried else "on the first try"
            parts.append(f"The model returned every line unchanged {tries}, so there is nothing to review.")
    elif model_changes == 0 and had_advice and summary.asked:
        tries = " after a second try with a checklist" if retried else ""
        parts.append(f"The model changed nothing on its own{tries}; only the changes you asked for were made.")
    if summary.asked:
        parts.append(f"{_plural(summary.asked, 'line')} changed because you asked.")
    if summary.protected_blocked:
        parts.append(
            f"{_plural(summary.protected_blocked, 'change')} the model made to a protected fact (a date, GPA, name, "
            f"title or an honor's numbers) {'needs' if summary.protected_blocked == 1 else 'need'} your OK: no note asked for "
            f"{'it' if summary.protected_blocked == 1 else 'them'}."
        )
    other_blocked = summary.blocked - summary.protected_blocked
    if other_blocked:
        reasons = " ".join(r for r in summary.block_reasons if "protected fact" not in r)[:300]
        parts.append(
            f"{_plural(other_blocked, 'rewrite needs', 'rewrites need')} your OK: the sources don't back up every "
            f"claim. {reasons}".strip()
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
    asks = sum(1 for i in items if i.status == ASKED)
    if asks:
        parts.append(f"{_plural(asks, 'note needs', 'notes need')} you to say which line.")
    couldnt = sum(1 for i in items if i.status == COULDNT_ACT)
    if couldnt:
        parts.append(f"{_plural(couldnt, 'item')} couldn't be acted on; each says why below.")
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
    asked: list[str] | tuple[str, ...] = (),
) -> tuple[list[CheckedRewrite], list[StepStats], RewriteSummary]:
    """Work through the score's advice, the person's notes and the model's own improvements, and check each change.

    ``keywords`` holds (skill, where it's backed up) for the posting's skills
    the person has but doesn't show. ``added`` holds the ids of facts the
    person added for this run; they're listed as notes and count as sources
    in the check. ``asked`` holds the notes that ask for a change ("change
    graduation date to 2027"): those are applied in code first, with the note
    as the source, and those lines aren't sent to the model.

    The model gets one second try, for two reasons. Rewrites that are blocked
    or have warnings go back with the checker's findings, and a retry
    replaces one only when it isn't blocked and has fewer warnings. And when
    the first answer changed nothing, or added none of the missing keywords,
    that counts as a failed attempt: the unchanged lines go back with every
    advice item and note as a checklist.

    A model change to a line it may not edit on its own (a date, an employer)
    is checked and blocked, so it shows instead of vanishing. Every advice
    item and note gets a result: applied, blocked, couldn't act, or a
    question for the person.
    """
    instructions, asked_rows = apply_instructions(ctx, list(asked), facts, added)
    asked_ids = {r.bullet_id for r in asked_rows}
    targets = ctx.rewrite_targets(asked_ids)
    target_ids = {t[0] for t in targets}
    facts_text = facts_prompt_text(facts)
    advice = advice_list(flags, keywords)
    notes = note_items(facts, added, list(asked))
    advice_prompt = [(a.id, a.text) for a in advice]
    notes_prompt = [(iid, f"(fact {fid}) {text}" if fid else text) for iid, fid, text in notes if fid]
    asked_lines = [f'[{r.bullet_id}] "{r.old_text}" is now "{r.new_text}" (I asked: {r.asked})' for r in asked_rows]
    protected = ctx.protected_parts([t[0] for t in targets])

    def prompt(lines: list[tuple[str, str, str]], feedback: str) -> str:
        return rewrite_prompt(posting, advice_prompt, notes_prompt, facts_text, lines, feedback,
                              [p for p in protected if p[0] in {t[0] for t in lines}], asked_lines)

    def off_target(proposals: list[Proposal]) -> tuple[list[CheckedRewrite], list[str]]:
        """Checked results for answers about lines the model may not change, and ids that aren't lines at all."""
        rows, unknown = [], []
        for p in proposals:
            if p.bullet_id in target_ids or p.bullet_id in asked_ids:
                continue
            row = ctx.check(p, facts, added) if ctx.line(p.bullet_id) else None
            if row is None:
                unknown.append(p.bullet_id)
            elif row.status != UNCHANGED:
                rows.append(row)
        return rows, unknown

    completion = provider.complete(ctx._request("rewrite", prompt(targets, ""), RewritesReply, 16000), on_delta)
    proposals = completion.data.rewrites
    reports = {r.item_id: r for r in completion.data.items}
    checked = ctx.check_all(proposals, facts, targets, added)
    extra, unknown = off_target(proposals)
    stats = [step_stats("rewrite", completion, checked + extra)]
    had_advice = bool(flags or keywords or added or asked)

    def finish(rows: list[CheckedRewrite], retried: bool, error: str) -> tuple:
        final = rows + extra + asked_rows
        order = [ln.id for ln in ctx.lines]
        # A new bullet sorts right after the bullet it follows.
        final.sort(key=lambda r: order.index(r.bullet_id) if r.bullet_id in order else order.index(r.bullet_id.split(":")[1]) + 0.5)
        items = item_results(ctx, final, advice, notes, instructions, reports)
        return final, stats, summarize(final, had_advice, unknown, retried, error, items)

    to_fix = [r for r in checked if r.status == BLOCKED or (r.status == OK and r.warnings)]
    no_edits = not any(r.status in (OK, BLOCKED) for r in checked)
    missed = unaddressed_keywords(checked, keywords)
    has_items = bool(advice or [n for n in notes if n[1]])
    unchanged = [r for r in checked if r.status == UNCHANGED] if has_items and (no_edits or missed) else []
    if not to_fix and not unchanged:
        return finish(checked, False, "")

    feedback = ""
    if to_fix:
        lines = "\n".join(f'[{r.bullet_id}] "{r.new_text}": {" ".join(r.reasons + r.warnings)}' for r in to_fix)
        feedback += RETRY_FEEDBACK.format(lines=lines)
    if unchanged:
        checklist = [f"[{iid}] {text}" for iid, text in advice_prompt + notes_prompt]
        feedback += NO_EDIT_FEEDBACK.format(items="\n".join(checklist))
    retry_ids = {r.bullet_id for r in to_fix + unchanged}
    retry_targets = [t for t in targets if t[0] in retry_ids]
    try:
        retry = provider.complete(ctx._request("rewrite_retry", prompt(retry_targets, feedback), RewritesReply, 16000),
                                  on_delta)
    except ProviderError as e:
        # The first attempt already gave a full result; a failed retry leaves it as is.
        return finish(checked, True, str(e) or e.kind)
    retry_proposals = retry.data.rewrites
    reports.update({r.item_id: r for r in retry.data.items})
    retry_extra, retry_unknown = off_target(retry_proposals)
    extra += [r for r in retry_extra if r.bullet_id not in {x.bullet_id for x in extra}]
    unknown += [u for u in retry_unknown if u not in unknown]
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

    return finish([better(r) for r in checked], True, "")


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
    return split_note_parts(note, [])[0]


def split_note_parts(note: str, lines: list[Line]) -> tuple[list[str], list[str]]:
    """Split a note into facts and requested changes.

    A piece that asks for a change ("change graduation date to 2027", "add
    Compilers to coursework", "fix my dates") is a requested change, kept as
    typed; ``instructions.py`` decides which line it means when the rewrite
    runs. Everything else goes through the fact rules of ``split_note``.
    """
    lex = skills.lexicon()
    facts: list[str] = []
    asked: list[str] = []
    for line in note.splitlines():
        line = line.strip().lstrip("-*•·").strip()
        for piece in _SENTENCE_END.split(line):
            piece = " ".join(piece.split()).rstrip(".")
            if not piece:
                continue
            if lines and parse_instructions("n0", piece, lines, canonical_skill):
                if piece not in asked:
                    asked.append(piece)
                continue
            named = lex.find(piece)
            if named and _ASKS_TO_ADD.match(piece):
                piece = "Skills: " + ", ".join(named)
            elif len(piece.split()) < 3 and not named:
                continue
            if piece not in facts:
                facts.append(piece)
    return facts, asked


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
    """The edits that turn the base resume into the tailored one. ``new:b5`` is a bullet added after b5."""
    lines = {s.id for s in doc.skills_lines()}
    skills_texts = {bid: text for bid, text in accepted.items() if bid in lines}
    edits: list = [
        SetText(slot=bid, text=text)
        for bid, text in sorted(accepted.items())
        if bid not in removed and (bid not in lines or posting is None) and not bid.startswith("new:")
    ]
    # Added bullets in the order they were asked for after each bullet: b5's first, then b5:2.
    added = sorted((bid for bid in accepted if bid.startswith("new:") and accepted[bid].strip()), key=lambda b: (b.split(":")[1], int(b.split(":")[2]) if b.count(":") > 1 else 1))
    for bid in reversed(added):
        anchor = bid.split(":")[1]
        if anchor not in removed:
            edits.append(AddBullet(slot=anchor, text=accepted[bid]))
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
