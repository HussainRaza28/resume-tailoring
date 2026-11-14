/**
 * Step tabs with a sliding thumb. The thumb is rebuilt from the public listing of
 * the bencho.dev "Jelly tabs" / "Tab bar" blocks; swap for the original when
 * available (see src/blocks/SOURCE.md).
 */
import { useLayoutEffect, useRef, useState } from "react";
import { IconCheck } from "./icons";

export type StepId = "diagnose" | "rewrite" | "rescore" | "export";
export const STEPS: { id: StepId; label: string }[] = [
  { id: "diagnose", label: "Diagnose" },
  { id: "rewrite", label: "Rewrite" },
  { id: "rescore", label: "Re-score" },
  { id: "export", label: "Export" },
];

type Props = {
  current: StepId;
  done: Set<StepId>;
  enabled: Set<StepId>;
  onSelect: (s: StepId) => void;
};

export default function Stepper({ current, done, enabled, onSelect }: Props) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [thumb, setThumb] = useState({ left: 4, width: 0 });

  useLayoutEffect(() => {
    const el = refs.current[current];
    if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  }, [current, done.size]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const order = STEPS.filter((s) => enabled.has(s.id)).map((s) => s.id);
    const i = order.indexOf(current);
    if (e.key === "ArrowRight" && i < order.length - 1) onSelect(order[i + 1]);
    else if (e.key === "ArrowLeft" && i > 0) onSelect(order[i - 1]);
    else return;
    e.preventDefault();
  };

  return (
    <div className="stepper" role="tablist" aria-label="Steps" onKeyDown={onKeyDown}>
      <span className="step-thumb" style={{ left: thumb.left, width: thumb.width }} />
      {STEPS.map((s, i) => (
        <button
          key={s.id}
          ref={(el) => {
            refs.current[s.id] = el;
          }}
          role="tab"
          className="step-tab"
          aria-selected={current === s.id}
          tabIndex={current === s.id ? 0 : -1}
          data-done={done.has(s.id)}
          disabled={!enabled.has(s.id)}
          onClick={() => onSelect(s.id)}
        >
          <span className="step-index">{done.has(s.id) ? <IconCheck size={12} /> : i + 1}</span>
          {s.label}
        </button>
      ))}
    </div>
  );
}
