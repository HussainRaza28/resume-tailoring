/**
 * Split view / Resizable panels.
 * Rebuilt from the public listings of the bencho.dev "Split view" and "Resizable
 * panels" blocks (drag interactions). Not the original source; swap for the
 * originals when available (see src/blocks/SOURCE.md).
 *
 * Two panes with a 1px divider. Drag the divider, or focus it and use the arrow
 * keys; double-click resets. The split ratio is remembered per `storageKey`.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

type Props = {
  left: ReactNode;
  right: ReactNode;
  initial?: number;
  min?: number;
  max?: number;
  storageKey?: string;
};

function load(key: string | undefined, fallback: number): number {
  if (!key) return fallback;
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export default function SplitView({ left, right, initial = 0.56, min = 0.36, max = 0.72, storageKey }: Props) {
  const [ratio, setRatio] = useState(() => load(storageKey, initial));
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const clamp = useCallback((r: number) => Math.min(max, Math.max(min, r)), [min, max]);

  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(ratio));
    } catch {
      /* storage unavailable: keep the ratio in memory */
    }
  }, [ratio, storageKey]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || !box.current) return;
    const rect = box.current.getBoundingClientRect();
    setRatio(clamp((e.clientX - rect.left) / rect.width));
  };
  const onPointerUp = () => setDragging(false);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    if (e.key === "ArrowLeft") setRatio((r) => clamp(r - step));
    else if (e.key === "ArrowRight") setRatio((r) => clamp(r + step));
    else if (e.key === "Home") setRatio(min);
    else if (e.key === "End") setRatio(max);
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={box}
      className="split"
      style={{ gridTemplateColumns: `minmax(0, ${ratio}fr) 1px minmax(0, ${1 - ratio}fr)`, cursor: dragging ? "col-resize" : undefined }}
    >
      <div className="pane">{left}</div>
      <div
        className="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        data-dragging={dragging}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setRatio(initial)}
        onKeyDown={onKeyDown}
      >
        <span className="splitter-grip" />
      </div>
      <div className="pane" style={{ pointerEvents: dragging ? "none" : undefined }}>
        {right}
      </div>
    </div>
  );
}
