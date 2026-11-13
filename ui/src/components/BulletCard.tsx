import { useEffect, useMemo, useRef, useState } from "react";
import type { CheckedRewrite, DecisionState, Fact } from "../lib/api";
import { changedShare, wordDiff } from "../lib/diff";
import { IconCheck, IconCopy, IconEdit, IconUndo, IconX } from "./icons";

type Props = {
  rewrite: CheckedRewrite;
  decision: DecisionState;
  focused: boolean;
  facts: Fact[];
  busy?: boolean;
  onFocus: () => void;
  onAccept: () => void;
  onReject: () => void;
  onReset: () => void;
  onEdit: (text: string) => Promise<void> | void;
  onAnswer?: (answer: string) => Promise<void> | void;
  onCopy: (text: string) => void;
  editRequest?: number;
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(r.new_text);
  const [answer, setAnswer] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const unchanged = r.status === "unchanged";
  const blocked = r.status === "blocked";

  useEffect(() => setDraft(r.new_text), [r.new_text]);
  useEffect(() => {
    if (p.focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [p.focused]);
  useEffect(() => {
    if (p.editRequest && p.focused) setEditing(true);
  }, [p.editRequest, p.focused]);

  const factFor = (id: string) => p.facts.find((f) => f.id === id);
  const sources = r.sources.filter((s) => s !== r.bullet_id);

  return (
    <div
      ref={ref}
      className="bullet enter"
      data-state={p.decision}
      data-focused={p.focused}
      onMouseDown={p.onFocus}
      aria-label={`Bullet ${r.bullet_id}`}
    >
      <div className="bullet-cols">
        <div>
          <div className="col-label">Original</div>
          <div className="col-text selectable" style={{ color: unchanged ? "var(--text)" : "var(--muted)" }}>
            {unchanged ? r.old_text : <DiffText oldText={r.old_text} newText={r.new_text} side="old" />}
          </div>
        </div>
        <div>
          <div className="col-label">
            {unchanged ? "No change needed" : "Rewrite"}
            {p.decision === "accepted" && <span className="pill pill-positive">Accepted</span>}
            {p.decision === "rejected" && <span className="pill">Kept original</span>}
            {blocked && <span className="pill pill-negative">Blocked</span>}
          </div>
          {editing ? (
            <div className="edit-box">
              <textarea
                className="textarea"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    await p.onEdit(draft);
                    setEditing(false);
                  } else if (e.key === "Escape") {
                    setEditing(false);
                    setDraft(r.new_text);
                  }
                  e.stopPropagation();
                }}
                aria-label="Edit the rewrite"
              />
              <div className="row">
                <span className="small faint grow">Enter to check and save, Esc to cancel. Your edit goes through the same checks.</span>
                <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={async () => {
                    await p.onEdit(draft);
                    setEditing(false);
                  }}
                >
                  Check and save
                </button>
              </div>
            </div>
          ) : (
            <div className="col-text selectable">{unchanged ? <span className="faint">Same as the original.</span> : <DiffText oldText={r.old_text} newText={r.new_text} side="new" />}</div>
          )}
        </div>
      </div>

      {blocked && r.reasons.length > 0 && (
        <div className="reasons" role="note">
          <strong>Blocked before you could accept it</strong>
          {r.reasons.map((reason, i) => (
            <span key={i}>{reason}</span>
          ))}
        </div>
      )}

      {r.question && p.onAnswer && (
        <form
          className="question"
          onSubmit={async (e) => {
            e.preventDefault();
            await p.onAnswer!(answer);
            setAnswer("");
          }}
        >
          <label htmlFor={`q-${r.bullet_id}`}>
            {r.question} <span className="faint">Leave blank to skip.</span>
          </label>
          <input id={`q-${r.bullet_id}`} className="input" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="e.g. 40" onKeyDown={(e) => e.stopPropagation()} />
          <button className="btn btn-sm" type="submit" disabled={p.busy}>
            {answer.trim() ? "Save to facts" : "Skip"}
          </button>
        </form>
      )}

      <div className="bullet-foot">
        <div className="receipts">
          <span>From</span>
          <span className="chip" title={r.old_text}>
            {r.bullet_id}
          </span>
          {sources.map((s) => {
            const f = factFor(s);
            return (
              <span key={s} className="chip" title={f ? f.text : s}>
                {s}
              </span>
            );
          })}
          {r.why && !unchanged && <span className="faint">· {r.why}</span>}
        </div>
        <div className="actions">
          <button className="btn btn-icon" aria-label="Copy this bullet" title="Copy" onClick={() => p.onCopy(r.new_text)}>
            <IconCopy />
          </button>
          {!unchanged && (
            <>
              <button className="btn btn-icon" aria-label="Edit (E)" title="Edit (E)" onClick={() => setEditing(true)}>
                <IconEdit />
              </button>
              {p.decision === "pending" ? (
                <>
                  <button className="btn btn-sm" onClick={p.onReject} aria-label="Keep original (Left arrow)">
                    <IconX /> Keep original
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={p.onAccept} disabled={blocked} aria-label="Accept rewrite (Right arrow)">
                    <IconCheck /> Accept
                  </button>
                </>
              ) : (
                <button className="btn btn-sm" onClick={p.onReset}>
                  <IconUndo /> Undo
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
