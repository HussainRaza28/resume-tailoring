import { useEffect, useMemo, useState } from "react";
import AsciiWake from "../blocks/AsciiWake";
import ArcRing from "../blocks/ArcRing";
import type { Coverage, Fact, RunState, SkillStatus } from "../lib/api";
import { modelLabel, providerLabel, runTotals } from "../lib/api";
import { duration, money, pct, tokens } from "../lib/format";
import BulletCard from "./BulletCard";
import { IconCheck, IconDownload, IconFolder } from "./icons";

/* ---------------- stream (loading) ---------------- */

export function StreamPanel({ title, text }: { title: string; text: string }) {
  const tail = text.slice(-900);
  return (
    <div className="card stream enter" aria-busy="true">
      <AsciiWake width={180} height={120} mode="loader" cell={8} label={title} />
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

/* ---------------- 1. red flags ---------------- */

export function RedFlagsStep({ run }: { run: RunState }) {
  const flags = run.red_flags?.red_flags ?? [];
  return (
    <div className="flags">
      {flags.map((f, i) => (
        <article key={i} className="flag enter" style={{ animationDelay: `${i * 70}ms` }}>
          <span className="flag-n">0{i + 1}</span>
          <h3>{f.flag}</h3>
          <p>{f.why}</p>
          <div>
            <span className="pill">{f.section}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

/* ---------------- 2. rewrite ---------------- */

type RewriteProps = {
  run: RunState;
  facts: Fact[];
  focus: number;
  busyBullet: string | null;
  editRequest: number;
  setFocus: (i: number) => void;
  decide: (bulletId: string, action: "accept" | "reject" | "reset" | "edit", text?: string) => Promise<void>;
  answer: (bulletId: string, answer: string) => Promise<void>;
  copy: (text: string) => void;
};

export function RewriteStep(p: RewriteProps) {
  const changed = p.run.rewrites.filter((r) => r.status !== "unchanged");
  const unchanged = p.run.rewrites.filter((r) => r.status === "unchanged");
  const [showSame, setShowSame] = useState(false);
  const visible = showSame ? [...changed, ...unchanged] : changed;
  let lastEntry = "";
  return (
    <div className="bullet-list">
      {changed.length === 0 && (
        <div className="card muted">Every bullet already holds up for this posting, so nothing was rewritten. You can go straight to the review.</div>
      )}
      {visible.map((r, i) => {
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
              busy={p.busyBullet === r.bullet_id}
              editRequest={p.editRequest}
              onFocus={() => p.setFocus(i)}
              onAccept={() => p.decide(r.bullet_id, "accept")}
              onReject={() => p.decide(r.bullet_id, "reject")}
              onReset={() => p.decide(r.bullet_id, "reset")}
              onEdit={(t) => p.decide(r.bullet_id, "edit", t)}
              onAnswer={(a) => p.answer(r.bullet_id, a)}
              onCopy={p.copy}
            />
          </div>
        );
      })}
      {unchanged.length > 0 && (
        <button className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }} onClick={() => setShowSame((s) => !s)}>
          {showSame ? "Hide" : "Show"} {unchanged.length} bullet{unchanged.length === 1 ? "" : "s"} that need no change
        </button>
      )}
    </div>
  );
}

/* ---------------- 3. review ---------------- */

function skillState(s: SkillStatus): "covered" | "addable" | "missing" {
  return s.covered ? "covered" : s.addable ? "addable" : "missing";
}

export function CoveragePanel({ before, after }: { before: Coverage | null; after: Coverage | null }) {
  const cov = after ?? before;
  if (!cov) return null;
  const req = cov.skills.filter((s) => s.tier === "required");
  const pref = cov.skills.filter((s) => s.tier === "preferred");
  const pctAfter = after && after.required_have ? after.required_covered / after.required_have : null;
  const pctBefore = before && before.required_have ? before.required_covered / before.required_have : null;
  const addable = cov.skills.filter((s) => s.addable && s.tier !== "mentioned");
  const Group = ({ name, list }: { name: string; list: SkillStatus[] }) =>
    list.length ? (
      <div style={{ display: "grid", gap: 8 }}>
        <span className="small muted">{name}</span>
        <div className="skills">
          {list.map((s) => (
            <span
              key={s.skill}
              className="skill"
              data-state={skillState(s)}
              title={s.covered ? "On your resume" : s.addable ? `You have this (${s.evidence === "base" ? "base resume" : `fact ${s.evidence}`}) but it is not shown` : "Not in your base resume or facts bank, so it cannot be added"}
            >
              {s.covered ? <IconCheck size={12} /> : s.addable ? "+ " : ""}
              {s.skill}
            </span>
          ))}
        </div>
      </div>
    ) : null;
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
      <Group name={`Required (${req.length})`} list={req} />
      <Group name={`Preferred (${pref.length})`} list={pref} />
      {addable.length > 0 && (
        <p className="small muted">
          {addable.length === 1 ? "One skill you have is" : `${addable.length} skills you have are`} missing from the page: {addable.map((s) => s.skill).join(", ")}. {addable.length === 1 ? "Mention it in a bullet edit; it is" : "Mention them in a bullet edit; they are"} backed by your {addable.some((s) => s.evidence !== "base") ? "facts bank" : "base resume"}.
        </p>
      )}
      <div className="legend">
        <span className="skill" data-state="covered">
          <IconCheck size={12} /> on the page
        </span>
        <span className="skill" data-state="addable">
          + you have it, not shown
        </span>
        <span className="skill" data-state="missing">
          not your experience
        </span>
      </div>
    </div>
  );
}

type ReviewProps = {
  run: RunState;
  facts: Fact[];
  acceptSuggestion: (section: number, bulletId: string) => Promise<void>;
  copy: (text: string) => void;
};

export function ReviewStep({ run, facts, acceptSuggestion, copy }: ReviewProps) {
  const before = run.review_before?.score ?? null;
  const after = run.review_after?.score ?? null;
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const sections = run.review_after?.skipped_sections ?? [];
  return (
    <div style={{ display: "grid", gap: "var(--gap)" }}>
      <div className="review-top">
        <div className="card score-card enter">
          <ArcRing value={after} before={before} size={168} />
          <div className="score-side">
            <h2>Match score</h2>
            <div className="score-compare num">
              <span>
                Base resume <strong>{before ?? "–"}</strong>
              </span>
              <span>
                With your changes <strong>{after ?? "–"}</strong>
              </span>
            </div>
            <p className="small faint">The model's opinion, reading as an ATS and a busy hiring manager. Keyword coverage below is counted in code and is the steadier number.</p>
          </div>
        </div>
        <CoveragePanel before={run.coverage_before} after={run.coverage_after} />
      </div>
      {run.review_after?.verdict && (
        <div className="card enter">
          <div className="card-head">
            <h2>Hiring manager's read</h2>
          </div>
          <p className="muted selectable">{run.review_after.verdict}</p>
        </div>
      )}
      {sections.length > 0 && (
        <div className="card enter">
          <div className="card-head">
            <h2>Sections that get skipped</h2>
            <span className="meta">{sections.length} found</span>
          </div>
          <div style={{ display: "grid", gap: 16 }}>
            {sections.map((s, si) => (
              <div key={si} style={{ display: "grid", gap: 10 }}>
                <div className="row">
                  <span className="pill">{s.section}</span>
                  <span className="muted">{s.reason}</span>
                </div>
                {s.rewrites.map((r) => {
                  const accepted = run.decisions[r.bullet_id]?.origin === "review" && run.rewrites.find((x) => x.bullet_id === r.bullet_id)?.new_text === r.new_text;
                  const key = `${si}:${r.bullet_id}`;
                  return (
                    <BulletCard
                      key={key}
                      rewrite={r}
                      decision={accepted ? "accepted" : rejected.has(key) ? "rejected" : "pending"}
                      focused={false}
                      facts={facts}
                      onFocus={() => {}}
                      onAccept={() => acceptSuggestion(si, r.bullet_id)}
                      onReject={() => setRejected((x) => new Set(x).add(key))}
                      onReset={() => setRejected((x) => {
                        const n = new Set(x);
                        n.delete(key);
                        return n;
                      })}
                      onEdit={() => {}}
                      onCopy={copy}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- 4. export ---------------- */

type ExportProps = {
  run: RunState;
  fileName: string;
  dir: string | null;
  exporting: boolean;
  chooseDir: () => void;
  exportPdf: () => void;
  removeBullet: (id: string) => void;
  reveal: () => void;
  status: string | null;
  setStatus: (s: string) => void;
};

export function ExportStep(p: ExportProps) {
  const accepted = Object.values(p.run.decisions).filter((d) => d.state === "accepted").length;
  const pagesOk = p.run.pages === 1;
  return (
    <div style={{ display: "grid", gap: "var(--gap)" }}>
      <div className="export-grid">
        <div className="card enter" style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <h2>Save the PDF</h2>
          <dl className="kv">
            <dt>File</dt>
            <dd className="mono selectable" style={{ fontSize: 12 }}>{p.fileName}</dd>
            <dt>Folder</dt>
            <dd title={p.dir ?? ""}>{p.dir ?? <span className="faint">Not chosen</span>}</dd>
            <dt>Pages</dt>
            <dd className="num">{p.run.pages == null ? <span className="faint">Compiling</span> : pagesOk ? "1" : <span style={{ color: "var(--negative)" }}>{p.run.pages}, needs trimming</span>}</dd>
            <dt>Accepted changes</dt>
            <dd className="num">{accepted}</dd>
          </dl>
          <div className="row">
            <button className="btn btn-sm" onClick={p.chooseDir}>
              <IconFolder /> Choose folder
            </button>
            <span className="grow" />
            <button className="btn btn-primary" onClick={p.exportPdf} disabled={p.exporting || !p.dir || p.run.pages !== 1}>
              <IconDownload /> {p.exporting ? "Exporting" : "Export PDF"}
            </button>
          </div>
          {p.run.exported_path && (
            <div className="notice" data-tone="info">
              <div className="notice-body">
                <span className="notice-title">Saved</span>
                <span className="muted small selectable">{p.run.exported_path}</span>
              </div>
              <button className="btn btn-sm" onClick={p.reveal}>
                Show in folder
              </button>
            </div>
          )}
        </div>
        <div className="card enter" style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <h2>Application</h2>
          <p className="muted small">Exporting adds this role to your tracker as tailored. Update it as it moves.</p>
          <div className="segmented" role="group" aria-label="Application status">
            {["tailored", "applied", "interview", "offer", "rejected"].map((s) => (
              <button key={s} aria-pressed={p.status === s} disabled={!p.status} onClick={() => p.setStatus(s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          {!p.status && <span className="small faint">Available after the first export.</span>}
        </div>
      </div>
      {p.run.pages != null && p.run.pages > 1 && (
        <div className="card enter" style={{ display: "grid", gap: 12 }}>
          <div className="card-head" style={{ marginBottom: 0 }}>
            <h2>Get back to one page</h2>
            <span className="meta">Fonts and margins never change</span>
          </div>
          <p className="muted small">These bullets end on a short last line, so a small cut saves a whole line. Edit one in the Rewrite step, or drop it here.</p>
          <div className="trim-list">
            {p.run.trim_hints.slice(0, 5).map((h) => (
              <div key={h.bullet_id} className="trim">
                <span>
                  <span className="chip">{h.bullet_id}</span> Cut about <b className="num">{h.cut_chars}</b> characters to save a line.{" "}
                  <span className="faint">{h.text.slice(0, 90)}…</span>
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
