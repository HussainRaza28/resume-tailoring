import { useEffect, useMemo, useState } from "react";
import AsciiWakeLoader from "../blocks/AsciiWakeLoader";
import ArcRing from "../blocks/ArcRing";
import type { Coverage, Fact, ItemResult, RunState, SkillStatus } from "../lib/api";
import { finalIsStale, modelLabel, providerLabel, runTotals } from "../lib/api";
import { duration, money, pct, tokens } from "../lib/format";
import { modKey } from "../lib/platform";
import { rewriteNote } from "../lib/rewriteNote";
import BulletCard from "./BulletCard";
import { IconCheck, IconDownload } from "./icons";

/* ---------------- stream (loading) ---------------- */

export function StreamPanel({ title, text }: { title: string; text: string }) {
  const tail = text.slice(-900);
  return (
    <div className="card stream enter" aria-busy="true">
      <AsciiWakeLoader width={180} height={120} mode="loader" cell={8} label={title} />
      <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
        <h2>{title}</h2>
        <div className="stream-text" aria-hidden="true">
          {tail || " "}
        </div>
      </div>
    </div>
  );
}

export function SkeletonList({ n = 3 }: { n?: number }) {
  return (
    <div className="bullet-list" aria-hidden="true">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="bullet">
          <div className="bullet-cols">
            <div style={{ display: "grid", gap: 8 }}>
              <div className="skeleton" style={{ height: 10, width: 60 }} />
              <div className="skeleton" style={{ height: 12 }} />
              <div className="skeleton" style={{ height: 12, width: "70%" }} />
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <div className="skeleton" style={{ height: 10, width: 60 }} />
              <div className="skeleton" style={{ height: 12 }} />
              <div className="skeleton" style={{ height: 12, width: "80%" }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- 1. score ---------------- */

type ScoreProps = {
  run: RunState;
  note: string;
  setNote: (v: string) => void;
  onRewrite: () => void;
  undoNote: () => void;
  busy: boolean;
};

export function ScoreStep({ run, note, setNote, onRewrite, undoNote, busy }: ScoreProps) {
  const s = run.score;
  if (!s) return null;
  const facts = run.note_fact_ids.length;
  const changes = (run.note_asks ?? []).length;
  const added = facts + changes;
  const addedText = [
    facts ? `${facts} fact${facts === 1 ? "" : "s"}` : "",
    changes ? `${changes} change${changes === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  return (
    <div style={{ display: "grid", gap: "var(--gap)" }}>
      <div className="card score-overview enter">
        <div className="score-overview-ring">
          <ArcRing value={s.ats} size={128} label="ATS score" />
          <span className="small muted">ATS score</span>
        </div>
        <ol className="flag-list" aria-label="Red flags">
          {s.red_flags.map((f, i) => (
            <li key={i}>
              <span className="flag-n">0{i + 1}</span>
              <div>
                <strong>{f.flag}</strong> <span className="pill">{f.section}</span>
                <p>{f.why}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="card note-card enter">
        <label htmlFor="note">Anything to add?</label>
        <textarea
          id="note"
          className="textarea"
          rows={3}
          value={note}
          placeholder={'Numbers, tools or results that aren\'t on your resume yet, or a change like "change graduation date to May 2027".'}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <div className="row">
          {added > 0 ? (
            <span className="small muted note-added">
              Added {addedText} ·{" "}
              <button className="link-button" onClick={undoNote}>
                Undo
              </button>
            </span>
          ) : (
            <span className="grow" />
          )}
          <span className="grow" />
          <button className="btn btn-primary" onClick={onRewrite} disabled={busy}>
            Rewrite <span className="kbd">{modKey}↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 2. rewrite ---------------- */

type RewriteProps = {
  run: RunState;
  facts: Fact[];
  focus: number;
  setFocus: (i: number) => void;
  decide: (bulletId: string, action: "accept" | "reject" | "reset") => Promise<void>;
};

export function RewriteStep(p: RewriteProps) {
  const changed = p.run.rewrites.filter((r) => r.status !== "unchanged");
  const note = rewriteNote(p.run);
  let lastEntry = "";
  return (
    <div className="bullet-list">
      {note && (
        <div className={changed.length ? "card muted small rewrite-note" : "card muted rewrite-note"} role="status">
          {note}
        </div>
      )}
      {(p.run.rewrite_summary?.items ?? []).length > 0 && <ItemList items={p.run.rewrite_summary!.items!} />}
      {changed.map((r, i) => {
        const head = r.entry !== lastEntry ? r.entry : null;
        lastEntry = r.entry;
        return (
          <div key={r.bullet_id} style={{ display: "grid", gap: 8 }}>
            {head && (
              <div className="entry-head">
                <strong>{head.split(" | ")[0].replace(/\*/g, "")}</strong>
                <span>{head.split(" | ").slice(1).join(" · ").replace(/\*/g, "")}</span>
              </div>
            )}
            <BulletCard
              rewrite={r}
              decision={p.run.decisions[r.bullet_id]?.state ?? "pending"}
              focused={p.focus === i}
              facts={p.facts}
              onFocus={() => p.setFocus(i)}
              onAccept={() => p.decide(r.bullet_id, "accept")}
              onReject={() => p.decide(r.bullet_id, "reject")}
              onReset={() => p.decide(r.bullet_id, "reset")}
            />
          </div>
        );
      })}
    </div>
  );
}

const ITEM_STATUS: Record<ItemResult["status"], { label: string; tone: string }> = {
  applied: { label: "Applied", tone: "pill-positive" },
  blocked: { label: "Blocked", tone: "pill-negative" },
  couldnt_act: { label: "Couldn't act", tone: "pill-warning" },
  ask: { label: "Which line?", tone: "pill-warning" },
};

/** One row per advice item and note: what the rewrite did with it, and why. */
export function ItemList({ items }: { items: ItemResult[] }) {
  return (
    <div className="card item-list enter">
      <h2>Advice and notes</h2>
      <ul aria-label="Advice and notes">
        {items.map((item) => {
          const s = ITEM_STATUS[item.status];
          return (
            <li key={item.id} data-status={item.status}>
              <span className={`pill ${s.tone}`}>{s.label}</span>
              <div>
                <strong>{item.kind === "note" ? `Your note: ${item.text}` : item.text}</strong>
                {item.why && <p>{item.why}</p>}
                {item.lines.length > 0 && item.status !== "ask" && (
                  <p className="small faint">
                    {item.lines.map((l) => (
                      <span key={l} className="chip">
                        {l}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ---------------- 3. done ---------------- */

type DoneProps = {
  run: RunState;
  fileName: string;
  dir: string | null;
  exporting: boolean;
  scoring: boolean;
  chooseDir: () => void;
  exportPdf: () => void;
  scoreAgain: () => void;
  removeBullet: (id: string) => void;
  reveal: () => void;
};

export function DoneStep(p: DoneProps) {
  const f = p.run.final;
  const pagesOk = p.run.pages === 1;
  const stale = finalIsStale(p.run);
  return (
    <div style={{ display: "grid", gap: "var(--gap)" }}>
      <div className="review-top">
        <div className="card score-card enter">
          <ArcRing value={f?.after ?? null} before={f?.before ?? null} size={150} label="Match score" />
          <div className="score-side">
            <h2>ATS score</h2>
            <div className="score-compare num">
              {f ? (
                <span>
                  <strong>{f.before}</strong> → <strong>{f.after}</strong>
                </span>
              ) : (
                <span className="faint">{p.scoring ? "Scoring…" : "Not scored yet"}</span>
              )}
            </div>
            {stale && (
              <button className="btn btn-sm" style={{ justifySelf: "start" }} onClick={p.scoreAgain} disabled={p.scoring}>
                Score again
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="card export-card enter">
        <dl className="kv">
          <dt>File</dt>
          <dd className="mono selectable" style={{ fontSize: 12 }}>{p.fileName}</dd>
          <dt>Folder</dt>
          <dd title={p.dir ?? ""}>
            {p.dir ?? <span className="faint">Not chosen</span>}{" "}
            <button className="link-button" onClick={p.chooseDir}>
              Change
            </button>
          </dd>
          <dt>Pages</dt>
          <dd className="num">{p.run.pages == null ? <span className="faint">…</span> : pagesOk ? "1" : <span style={{ color: "var(--negative)" }}>{p.run.pages}</span>}</dd>
        </dl>
        <div className="row">
          {p.run.exported_path ? (
            <button className="link-button small" onClick={p.reveal}>
              Show in folder
            </button>
          ) : (
            <span className="grow" />
          )}
          <span className="grow" />
          <button className="btn btn-primary" onClick={p.exportPdf} disabled={p.exporting || !p.dir || p.run.pages !== 1}>
            <IconDownload /> {p.exporting ? "Exporting" : "Export PDF"}
          </button>
        </div>
      </div>
      <CoveragePanel before={p.run.coverage_before} after={p.run.coverage_after} />
      {p.run.pages != null && p.run.pages > 1 && (
        <div className="card enter" style={{ display: "grid", gap: 12 }}>
          <h2>Over one page</h2>
          <div className="trim-list">
            {p.run.trim_hints.slice(0, 5).map((h) => (
              <div key={h.bullet_id} className="trim">
                <span>
                  <span className="chip">{h.bullet_id}</span> Cut <b className="num">{h.cut_chars}</b> characters to save a line. <span className="faint">{h.text.slice(0, 90)}…</span>
                </span>
                <button className="btn btn-sm" onClick={() => p.removeBullet(h.bullet_id)}>
                  Drop bullet
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- keyword coverage ---------------- */

type CoverageGroup = { id: "covered" | "addable" | "missing"; title: string; skills: SkillStatus[] };

/** Required first, then preferred; the posting's own order inside each. */
function byTier(list: SkillStatus[]): SkillStatus[] {
  return [...list.filter((s) => s.tier === "required"), ...list.filter((s) => s.tier === "preferred")];
}

function evidenceNote(s: SkillStatus): string {
  return s.evidence === "base" ? "In your base resume" : s.evidence ? `In your facts bank (${s.evidence})` : "";
}

export function CoveragePanel({ before, after }: { before: Coverage | null; after: Coverage | null }) {
  const cov = after ?? before;
  if (!cov) return null;
  const listed = cov.skills.filter((s) => s.tier === "required" || s.tier === "preferred");
  const pctAfter = after && after.required_have ? after.required_covered / after.required_have : null;
  const pctBefore = before && before.required_have ? before.required_covered / before.required_have : null;
  const groups: CoverageGroup[] = [
    { id: "covered", title: "On your resume", skills: byTier(listed.filter((s) => s.covered)) },
    {
      id: "addable",
      title: "You have it, not shown",
      skills: byTier(listed.filter((s) => !s.covered && s.have)),
    },
    { id: "missing", title: "Not in your experience", skills: byTier(listed.filter((s) => !s.covered && !s.have)) },
  ];
  return (
    <div className="card coverage-rows">
      <div className="coverage-head">
        <h2>Keyword coverage</h2>
        <span className="small faint">Counted in code, not by the model</span>
      </div>
      <div className="coverage-head">
        <span className="big num">{after ? `${after.required_covered} of ${after.required_have}` : "–"}</span>
        <span className="muted">required skills you have are on the page</span>
        <span className="num change">
          {pct(pctBefore)} → <span style={{ color: "var(--text)" }}>{pct(pctAfter)}</span>
        </span>
      </div>
      <div className="bar" aria-hidden="true">
        <span style={{ width: `${(pctAfter ?? 0) * 100}%` }} />
      </div>
      <div className="coverage-groups">
        {groups.map((g) => (
          <section key={g.id} className="coverage-group" data-state={g.id} aria-label={`${g.title} (${g.skills.length})`}>
            <div className="coverage-group-head">
              <h3>
                {g.title} <span className="num">({g.skills.length})</span>
              </h3>
            </div>
            {g.skills.length ? (
              <ul className="skills">
                {g.skills.map((s) => (
                  <li key={s.skill} className="skill" data-state={g.id} title={g.id === "addable" ? evidenceNote(s) : undefined}>
                    {g.id === "covered" && <IconCheck size={12} />}
                    {s.skill}
                    <span className="tier" data-tier={s.tier}>
                      {s.tier === "required" ? "Required" : "Preferred"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="small faint">None</span>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

/* ---------------- footer ---------------- */

export function CostFooter({ run }: { run: RunState | null }) {
  const t = useMemo(() => (run ? runTotals(run) : null), [run]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!run || run.exported_at_ms) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [run]);
  if (!run || !t) return <footer className="cost-footer" />;
  const elapsed = run.pasted_at_ms ? Math.max(0, (run.exported_at_ms ?? Math.max(now, Date.now())) - run.pasted_at_ms) : null;
  return (
    <footer className="cost-footer num" aria-label="Run cost and time">
      <span>
        <b>{providerLabel(run.provider)}</b> {modelLabel(run.model)}
      </span>
      <span>
        <b>{tokens(t.input)}</b> in{t.cached ? ` (${tokens(t.cached)} cached)` : ""} · <b>{tokens(t.output)}</b> out
      </span>
      <span>
        <b>{money(t.cost)}</b>
      </span>
      <span className="opt">
        model time <b>{duration(t.ms)}</b>
      </span>
      <span style={{ marginLeft: "auto" }}>
        {run.exported_at_ms ? "paste to PDF" : "since paste"} <b>{duration(elapsed)}</b>
      </span>
    </footer>
  );
}
