import { useEffect, useMemo, useRef } from "react";
import type { CheckedRewrite, DecisionState, Fact } from "../lib/api";
import { changedShare, wordDiff } from "../lib/diff";
import { IconCheck, IconUndo, IconX } from "./icons";

type Props = {
  rewrite: CheckedRewrite;
  decision: DecisionState;
  focused: boolean;
  facts: Fact[];
  onFocus: () => void;
  onAccept: () => void;
  onReject: () => void;
  onReset: () => void;
};

export function DiffText({ oldText, newText, side }: { oldText: string; newText: string; side: "old" | "new" }) {
  const ops = useMemo(() => wordDiff(oldText, newText), [oldText, newText]);
  // A bullet that was mostly reworded reads better as two plain sentences than as
  // a wall of strike-through; only partial edits get word highlights.
  if (changedShare(ops) > 0.62) return <span style={{ color: side === "old" ? "var(--muted)" : "var(--text)" }}>{side === "old" ? oldText : newText}</span>;
  return (
    <>
      {ops.map((o, i) =>
        o.kind === "same" ? (
          <span key={i}>{o.text}</span>
        ) : o.kind === "removed" && side === "old" ? (
          <del key={i} className="diff-removed">
            {o.text}
          </del>
        ) : o.kind === "added" && side === "new" ? (
          <ins key={i} className="diff-added" style={{ textDecoration: "none" }}>
            {o.text}
          </ins>
        ) : null,
      )}
    </>
  );
}

export default function BulletCard(p: Props) {
  const r = p.rewrite;
  const ref = useRef<HTMLDivElement>(null);
  const unchanged = r.status === "unchanged";
  // Only a claim the sources don't back up blocks. Style findings are warnings.
  const blocked = r.status === "blocked";
  const warnings = r.warnings ?? [];

  useEffect(() => {
    if (p.focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [p.focused]);

  const factFor = (id: string) => p.facts.find((f) => f.id === id);
  const sources = r.sources.filter((s) => s !== r.bullet_id);

  return (
    <div ref={ref} className="bullet enter" data-state={p.decision} data-focused={p.focused} onMouseDown={p.onFocus} aria-label={`Bullet ${r.bullet_id}`}>
      <div className="bullet-cols">
        <div>
          <div className="col-label">Original</div>
          <div className="col-text selectable" style={{ color: "var(--muted)" }}>
            <DiffText oldText={r.old_text} newText={r.new_text} side="old" />
          </div>
        </div>
        <div>
          <div className="col-label">
            New
            {p.decision === "accepted" && <span className="pill pill-positive">Accepted</span>}
            {p.decision === "rejected" && <span className="pill">Kept original</span>}
            {blocked && <span className="pill pill-negative">Blocked</span>}
            {!blocked && !unchanged && warnings.length > 0 && <span className="pill pill-warning">Check style</span>}
          </div>
          <div className="col-text selectable">
            <DiffText oldText={r.old_text} newText={r.new_text} side="new" />
          </div>
        </div>
      </div>

      {blocked && r.reasons.length > 0 && (
        <div className="reasons" role="note">
          {r.reasons.map((reason, i) => (
            <span key={i}>{reason}</span>
          ))}
        </div>
      )}

      {!blocked && !unchanged && warnings.length > 0 && (
        <div className="reasons reasons-warning" role="note">
          {warnings.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
      )}

      <div className="bullet-foot">
        <div className="receipts">
          <span>From</span>
          <span className="chip" title={r.old_text}>
            {r.bullet_id}
          </span>
          {sources.map((s) => (
            <span key={s} className="chip" title={factFor(s)?.text ?? s}>
              {s}
            </span>
          ))}
          {r.why && <span className="faint">· {r.why}</span>}
        </div>
        {!unchanged && (
          <div className="actions">
            {p.decision === "pending" ? (
              <>
                <button className="btn btn-sm" onClick={p.onReject} aria-label="Keep original">
                  <IconX /> Keep original
                </button>
                <button className="btn btn-sm btn-primary" onClick={p.onAccept} disabled={blocked} aria-label="Accept">
                  <IconCheck /> Accept
                </button>
              </>
            ) : (
              <button className="btn btn-sm" onClick={p.onReset}>
                <IconUndo /> Undo
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
