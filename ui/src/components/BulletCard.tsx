import { useEffect, useMemo, useRef } from "react";
import type { CheckedRewrite, DecisionState, Fact } from "../lib/api";
import { boldRuns, changedShare, parseBold, wordDiff } from "../lib/diff";
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

/** Text with its bold shown as real bold. */
function Bold({ text, bold, offset }: { text: string; bold: boolean[]; offset: number }) {
  return (
    <>
      {boldRuns(text, bold, offset).map((run, i) => (run.bold ? <strong key={i}>{run.text}</strong> : <span key={i}>{run.text}</span>))}
    </>
  );
}

/** One side of an old/new comparison. Bold is written **like this** in the text and
 *  shown as real bold; the diff itself compares the words without the markers. */
export function DiffText({ oldText, newText, side }: { oldText: string; newText: string; side: "old" | "new" }) {
  const oldParsed = useMemo(() => parseBold(oldText), [oldText]);
  const newParsed = useMemo(() => parseBold(newText), [newText]);
  const ops = useMemo(() => wordDiff(oldParsed.plain, newParsed.plain), [oldParsed.plain, newParsed.plain]);
  const mine = side === "old" ? oldParsed : newParsed;
  // A bullet that was mostly reworded reads better as two plain sentences than as
  // a wall of strike-through; only partial edits get word highlights.
  if (changedShare(ops) > 0.62)
    return (
      <span style={{ color: side === "old" ? "var(--muted)" : "var(--text)" }}>
        <Bold text={mine.plain} bold={mine.bold} offset={0} />
      </span>
    );
  let offset = 0;
  return (
    <>
      {ops.map((o, i) => {
        const shown = o.kind === "same" || (o.kind === "removed" && side === "old") || (o.kind === "added" && side === "new");
        if (!shown) return null;
        const at = offset;
        offset += o.text.length;
        const inner = <Bold text={o.text} bold={mine.bold} offset={at} />;
        return o.kind === "same" ? (
          <span key={i}>{inner}</span>
        ) : o.kind === "removed" ? (
          <del key={i} className="diff-removed">
            {inner}
          </del>
        ) : (
          <ins key={i} className="diff-added" style={{ textDecoration: "none" }}>
            {inner}
          </ins>
        );
      })}
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
  const sources = r.sources.filter((s) => s !== r.bullet_id && s !== "note");
  const asked = !!r.asked && !unchanged;

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

      {asked && (
        <div className="asked-note" role="note">
          Changed because you asked: <q>{r.asked}</q>
        </div>
      )}

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
          {r.label && r.label !== "Bullet" && <span className="faint">{r.label}</span>}
          {sources.map((s) => (
            <span key={s} className="chip" title={factFor(s)?.text ?? s}>
              {s}
            </span>
          ))}
          {r.why && <span className="faint">· {r.why}</span>}
        </div>
        {asked && !blocked && (
          <div className="actions">
            {p.decision === "accepted" ? (
              <button className="btn btn-sm" onClick={p.onReject} aria-label="Undo">
                <IconUndo /> Undo
              </button>
            ) : (
              <button className="btn btn-sm" onClick={p.onAccept} aria-label="Redo">
                <IconCheck /> Redo
              </button>
            )}
          </div>
        )}
        {!unchanged && !(asked && !blocked) && (
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
