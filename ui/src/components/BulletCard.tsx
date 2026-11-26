import { useEffect, useMemo, useRef, useState } from "react";
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
  /** Save the person's own text for this line. */
  onEdit?: (text: string) => void;
};

/** How a change the person made or asked for is introduced on its card. */
function askedLine(kind: string | undefined, note: string): { lead: string; quote: string | null } {
  if (kind === "edit" || note === "Your edit") return { lead: "Your edit", quote: null };
  return { lead: kind === "add" ? "Added because you asked:" : "Changed because you asked:", quote: note };
}

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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(r.new_text);
  useEffect(() => setDraft(r.new_text), [r.new_text]);
  const said = asked ? askedLine(r.asked_kind, r.asked!) : null;

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
            {blocked && p.decision !== "accepted" && <span className="pill pill-warning">Needs your OK</span>}
            {!blocked && !unchanged && warnings.length > 0 && <span className="pill pill-warning">Check style</span>}
          </div>
          {editing ? (
            <div className="edit-line">
              <textarea className="textarea" rows={3} value={draft} aria-label={`Edit ${r.label || "line"}`} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
              <div className="row">
                <button className="btn btn-sm btn-primary" onClick={() => { p.onEdit?.(draft); setEditing(false); }}>
                  Save
                </button>
                <button className="btn btn-sm" onClick={() => { setDraft(r.new_text); setEditing(false); }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="col-text selectable">
              <DiffText oldText={r.old_text} newText={r.new_text} side="new" />
            </div>
          )}
        </div>
      </div>

      {said && (
        <div className="asked-note" role="note">
          {said.lead}
          {said.quote && (
            <>
              {" "}
              <q>{said.quote}</q>
            </>
          )}
        </div>
      )}

      {blocked && r.reasons.length > 0 && (
        <div className="reasons reasons-warning" role="note">
          <span>Needs your OK: the model wrote this, and the checks found something your resume and facts don't back up.</span>
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
        {p.onEdit && !editing && (
          <button className="btn btn-sm" onClick={() => setEditing(true)} aria-label={`Edit ${r.label || "line"}`}>
            Edit
          </button>
        )}
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
                <button className="btn btn-sm btn-primary" onClick={p.onAccept} aria-label="Accept">
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
