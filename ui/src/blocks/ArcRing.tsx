/**
 * Arc ring.
 * Rebuilt from the public listing of the bencho.dev "Arc ring" block (a hover
 * interaction on a ring gauge). Not the original source; swap for the original when
 * available (see src/blocks/SOURCE.md).
 *
 * A 270-degree arc that sweeps to `value`. `before` draws a faint second arc and a
 * tick, so the before/after change reads on the gauge itself. Hovering shows the
 * exact before and after values in the centre.
 */
import { useEffect, useState } from "react";

type Props = {
  value: number | null;
  before?: number | null;
  size?: number;
  label?: string;
};

const SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const [x0, y0] = polar(cx, cy, r, from);
  const [x1, y1] = polar(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

export default function ArcRing({ value, before = null, size = 184, label = "Match score" }: Props) {
  const [shown, setShown] = useState(0);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (value == null) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const from = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 900);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(Math.round(from + (value - from) * e));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  const stroke = 10;
  const r = size / 2 - stroke;
  const c = size / 2;
  const start = -SWEEP / 2;
  const end = SWEEP / 2;
  const at = (v: number) => start + (Math.max(0, Math.min(100, v)) / 100) * SWEEP;
  const delta = value != null && before != null ? value - before : null;
  const [tx0, ty0] = before != null ? polar(c, c, r - stroke / 2 - 3, at(before)) : [0, 0];
  const [tx1, ty1] = before != null ? polar(c, c, r + stroke / 2 + 3, at(before)) : [0, 0];

  return (
    <div
      className="arc-ring"
      style={{ position: "relative", width: size, height: size * 0.86 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      aria-valuetext={value == null ? "Not scored yet" : `${value} out of 100${delta != null ? `, ${delta >= 0 ? "up" : "down"} ${Math.abs(delta)} from ${before}` : ""}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <path d={arc(c, c, r, start, end)} fill="none" stroke="var(--raised)" strokeWidth={stroke} strokeLinecap="round" />
        {before != null && (
          <path d={arc(c, c, r, start, at(before))} fill="none" stroke="var(--control)" strokeWidth={stroke} strokeLinecap="round" />
        )}
        {value != null && shown > 0 && (
          <path
            d={arc(c, c, r, start, at(shown))}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={stroke}
            strokeLinecap="round"
            style={{ mixBlendMode: "normal" }}
          />
        )}
        {before != null && <line x1={tx0} y1={ty0} x2={tx1} y2={ty1} stroke="var(--text)" strokeWidth={2} strokeLinecap="round" />}
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeContent: "center",
          textAlign: "center",
          paddingBottom: size * 0.08,
        }}
      >
        <div className="num" style={{ fontSize: 36, fontWeight: 600, lineHeight: 1, letterSpacing: "-0.02em" }}>
          {value == null ? "–" : shown}
        </div>
        <div className="small muted num" style={{ marginTop: 6, minHeight: 18 }}>
          {hover && before != null && value != null
            ? `${before} before, ${value} after`
            : delta != null
              ? `${delta > 0 ? "+" : ""}${delta} from ${before}`
              : "out of 100"}
        </div>
      </div>
    </div>
  );
}
