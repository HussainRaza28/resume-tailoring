/**
 * ASCII wake, loader variant.
 * Rebuilt for this app from the public description of the bencho.dev "ASCII wake"
 * block. The original (AsciiWake.tsx) follows the pointer; this version drives the
 * wake itself on an orbit, so it reads as work in progress while a step runs.
 * With Reduce Motion the cube is drawn once, still.
 */
import { useEffect, useRef } from "react";

const RAMP = " .·:-=+*#%@";

type Props = {
  width?: number;
  height?: number;
  mode?: "hero" | "loader";
  cell?: number;
  label?: string;
};

type Ring = { x: number; y: number; r: number; life: number };

export default function AsciiWakeLoader({ width = 420, height = 220, mode = "hero", cell = 9, label }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const cw = cell;
    const ch = Math.round(cell * 1.45);
    const cols = Math.floor(width / cw);
    const rows = Math.floor(height / ch);
    const heat = new Float32Array(cols * rows);
    const ink = new Uint8Array(cols * rows);
    const rings: Ring[] = [];
    const pointer = { x: -999, y: -999, px: -999, py: -999, inside: false };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const style = getComputedStyle(canvas);
    const inkColor = style.getPropertyValue("--wake-ink").trim() || "#eee";
    const dotColor = style.getPropertyValue("--wake-dot").trim() || "rgba(255,255,255,0.2)";
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono") || "monospace";

    // Points on the cube: dense along the 12 edges, sparse on the faces.
    const pts: [number, number, number][] = [];
    const n = 16;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 2 - 1;
      for (const a of [-1, 1])
        for (const b of [-1, 1]) {
          pts.push([t, a, b], [a, t, b], [a, b, t]);
        }
    }
    const f = 6;
    for (let i = 1; i < f; i++)
      for (let j = 1; j < f; j++) {
        const u = (i / f) * 2 - 1;
        const v = (j / f) * 2 - 1;
        for (const s of [-1, 1]) pts.push([u, v, s], [u, s, v], [s, u, v]);
      }

    const addHeat = (x: number, y: number, radius: number, amount: number) => {
      const c0 = Math.max(0, Math.floor((x - radius) / cw));
      const c1 = Math.min(cols - 1, Math.ceil((x + radius) / cw));
      const r0 = Math.max(0, Math.floor((y - radius) / ch));
      const r1 = Math.min(rows - 1, Math.ceil((y + radius) / ch));
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const dx = c * cw + cw / 2 - x;
          const dy = r * ch + ch / 2 - y;
          const d = Math.hypot(dx, dy);
          if (d < radius) {
            const k = r * cols + c;
            heat[k] = Math.min(1, heat[k] + amount * (1 - d / radius));
          }
        }
    };

    let raf = 0;
    let t0 = performance.now();
    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      ink.fill(0);
      const ay = t * 0.45 + 0.6;
      const ax = 0.55 + Math.sin(t * 0.3) * 0.12;
      const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax);
      const scale = Math.min(width, height * 1.45) * 0.24;
      for (const [x0, y0, z0] of pts) {
        const x1 = x0 * cy + z0 * sy;
        const z1 = -x0 * sy + z0 * cy;
        const y2 = y0 * cx - z1 * sx;
        const z2 = y0 * sx + z1 * cx;
        const p = 3.2 / (3.2 + z2);
        const px = width / 2 + x1 * scale * p;
        const py = height / 2 + y2 * scale * p * 1.02;
        const c = Math.floor(px / cw);
        const r = Math.floor(py / ch);
        if (c >= 0 && c < cols && r >= 0 && r < rows) ink[r * cols + c] = z2 < 0 ? 2 : 1;
      }

      if (mode === "loader" || !pointer.inside) {
        // an orbiting hand so the wake moves on its own
        const ox = width / 2 + Math.cos(t * 1.7) * width * 0.3;
        const oy = height / 2 + Math.sin(t * 2.3) * height * 0.28;
        if (mode === "loader" || t < 4) addHeat(ox, oy, 26, 0.18);
      }
      if (pointer.inside) {
        const steps = Math.max(1, Math.ceil(Math.hypot(pointer.x - pointer.px, pointer.y - pointer.py) / 6));
        for (let s = 0; s <= steps; s++) {
          const k = s / steps;
          addHeat(pointer.px + (pointer.x - pointer.px) * k, pointer.py + (pointer.y - pointer.py) * k, 30, 0.12);
        }
        pointer.px = pointer.x;
        pointer.py = pointer.y;
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        ring.r += 7;
        ring.life -= 0.035;
        for (let a = 0; a < Math.PI * 2; a += 0.08) addHeat(ring.x + Math.cos(a) * ring.r, ring.y + Math.sin(a) * ring.r, 14, 0.35 * ring.life);
        if (ring.life <= 0) rings.splice(i, 1);
      }

      ctx.clearRect(0, 0, width, height);
      ctx.font = `${Math.round(ch * 0.82)}px ${mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const k = r * cols + c;
          const h = heat[k];
          heat[k] = h * 0.93;
          const on = ink[k];
          if (!on && h < 0.06) continue;
          let level = on ? (on === 2 ? 2 : 1) : 0;
          if (h > 0.06) level = Math.max(level, Math.min(RAMP.length - 1, Math.round(1 + h * (RAMP.length - 2)) + (on ? 1 : 0)));
          if (level <= 0) continue;
          const glyph = RAMP[Math.min(RAMP.length - 1, level)];
          ctx.fillStyle = level <= 2 && h < 0.06 ? dotColor : inkColor;
          ctx.globalAlpha = on ? 1 : Math.min(1, 0.25 + h);
          ctx.fillText(glyph, c * cw + cw / 2, r * ch + ch / 2);
        }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(draw);
    };

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (!pointer.inside) {
        pointer.px = x;
        pointer.py = y;
      }
      pointer.x = x;
      pointer.y = y;
      pointer.inside = true;
    };
    const onLeave = () => (pointer.inside = false);
    const onDown = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      rings.push({ x: e.clientX - rect.left, y: e.clientY - rect.top, r: 4, life: 1 });
    };
    if (mode === "hero" && !reduce) {
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerleave", onLeave);
      canvas.addEventListener("pointerdown", onDown);
    }
    t0 = performance.now();
    if (reduce) draw(t0 + 1400);
    else raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
    };
  }, [width, height, mode, cell]);

  return (
    <canvas
      ref={ref}
      style={{ width, height }}
      role="img"
      aria-label={label ?? (mode === "loader" ? "Working" : "A cube drawn in dots that ripples under the pointer")}
    />
  );
}
