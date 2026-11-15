/**
 * A small ASCII wake for the profile page header: the Tailor app's landscape
 * page of halftone dots (ui/src/blocks/AsciiWake.tsx), drawn smaller and
 * without React. The pointer drags a wake through it, the dots thickening to
 * glyphs under the hand and cooling back to dots behind it.
 */

const RAMP = [" ", ".", ":", "-", "=", "+", "*", "#", "%", "@"];
const MONO = `"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
const COLD = 0.04;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** The page: a rounded landscape sheet with a crisp edge and a few ruled lines. Dot size 0..1. */
export function pageDensity(x: number, y: number, w: number, h: number, dark: boolean): number {
  const r = h * 0.16;
  const qx = Math.abs(x) - (w - r);
  const qy = Math.abs(y) - (h - r);
  const edge = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  if (edge > 0) return 0;
  if (edge > -h * 0.06) return 0.9;
  const down = (y + h) / (2 * h);
  const across = (x + w * 0.86) / (w * 1.72);
  const lines: [number, number][] = [
    [0.13, 0.42],
    [0.26, 0.9],
    [0.35, 0.84],
    [0.44, 0.62],
    [0.58, 0.88],
    [0.67, 0.9],
    [0.76, 0.7],
    [0.88, 0.8],
  ];
  for (const [at, fill] of lines) {
    if (Math.abs(down - at) < 0.024 && across >= 0 && across <= fill) return 0.62;
  }
  return 0.1 + 0.06 * (dark ? 1 - down : down);
}

function hash(k: number, n: number): number {
  let h = (k * 374761393 + n * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Draw the wake into ``canvas`` and follow the pointer over it. */
export function mountWake(canvas: HTMLCanvasElement, width = 220, height = 104, size = 8): void {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const g = canvas.getContext("2d");
  if (!g) return;

  const cw = size * 0.62;
  const ch = size * 0.82;
  const cols = Math.floor(width / cw - 0.5);
  const rows = Math.floor(height / ch);
  const ox = (width - cols * cw) / 2;
  const oy = (height - rows * ch) / 2;
  const heat = new Float32Array(cols * rows);
  let mask = new Float32Array(cols * rows);
  let hx = -999;
  let hy = -999;
  let lx = NaN;
  let ly = NaN;
  let inside = false;
  let near = 0;
  let deal = 0;
  let tick = 0;
  let raf = 0;
  const rad = 22;

  const isDark = () => {
    const ink = getComputedStyle(canvas).color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
    return ink[0] * 0.299 + ink[1] * 0.587 + ink[2] * 0.114 > 128;
  };

  const build = () => {
    const dark = isDark();
    mask = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = ox + (i + 0.5 + (j & 1) * 0.5) * cw - width / 2;
        const y = oy + (j + 0.5) * ch - height / 2;
        mask[j * cols + i] = pageDensity(x, y, width * 0.46, height * 0.44, dark);
      }
    }
  };

  const stamp = (x: number, y: number) => {
    x -= ox;
    y -= oy;
    const c0 = Math.max(0, Math.floor((x - rad) / cw));
    const c1 = Math.min(cols - 1, Math.ceil((x + rad) / cw));
    const r0 = Math.max(0, Math.floor((y - rad) / ch));
    const r1 = Math.min(rows - 1, Math.ceil((y + rad) / ch));
    for (let j = r0; j <= r1; j++) {
      for (let i = c0; i <= c1; i++) {
        const q = (((i + 0.5) * cw - x) ** 2 + ((j + 0.5) * ch - y) ** 2) / (rad * rad);
        if (q >= 1) continue;
        const k = j * cols + i;
        heat[k] = Math.min(1, heat[k] + 0.5 * (1 - q) * (1 - q));
      }
    }
  };

  const paint = () => {
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);
    g.fillStyle = getComputedStyle(canvas).color;
    g.font = `500 ${size}px ${MONO}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    const dot = Math.min(cw, ch) * 0.44;
    const top = RAMP.length - 1;
    for (let j = 0; j < rows; j++) {
      const y = oy + (j + 0.5) * ch;
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        const m = mask[k];
        if (m <= 0) continue;
        const x = ox + (i + 0.5 + (j & 1) * 0.5) * cw;
        let h = heat[k];
        if (near > 0.002) {
          const q = ((x - hx) ** 2 + (y - hy) ** 2) / (rad * rad);
          if (q < 1) h = Math.max(h, 0.95 * near * (1 - q) * (1 - q));
        }
        h *= 0.55 + 0.45 * m;
        let u = Math.min(1, h) * top + 0.5;
        if (h > COLD) u += (hash(k, deal) - 0.5) * 1.6 * Math.min(1, h * 2);
        const idx = clamp(Math.floor(u), 1, top);
        if (h <= COLD || idx === 1) {
          g.beginPath();
          g.arc(x, y, Math.max(0.45, dot * Math.sqrt(m)), 0, Math.PI * 2);
          g.fill();
        } else {
          g.fillText(RAMP[idx], x, y);
        }
      }
    }
  };

  const run = () => {
    if (raf) return;
    let prev = performance.now();
    const step = (t: number) => {
      const dt = Math.min(0.05, (t - prev) / 1000);
      prev = t;
      const keep = Math.exp((-dt * 3) / 1.2);
      let warm = 0;
      for (let k = 0; k < heat.length; k++) {
        const h = heat[k] * keep;
        heat[k] = h < 0.003 ? 0 : h;
        if (h > warm) warm = h;
      }
      near += ((inside ? 1 : 0) - near) * (1 - Math.pow(0.004, dt));
      tick += dt;
      if (tick > 0.07) {
        tick = 0;
        deal++;
      }
      paint();
      const still = warm === 0 && Math.abs((inside ? 1 : 0) - near) < 0.004;
      raf = still ? 0 : requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const move = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * width;
    const y = ((e.clientY - r.top) / r.height) * height;
    if (Number.isNaN(lx)) {
      lx = x;
      ly = y;
    }
    const n = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / (rad / 3)));
    for (let k = 1; k <= n; k++) stamp(lx + ((x - lx) * k) / n, ly + ((y - ly) * k) / n);
    lx = x;
    ly = y;
    hx = x;
    hy = y;
    inside = true;
    run();
  };

  canvas.addEventListener("pointerenter", (e) => {
    lx = NaN;
    move(e);
  });
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerleave", () => {
    inside = false;
    lx = NaN;
    run();
  });

  build();
  paint();
  // A theme change turns the shading round, so the field is rebuilt.
  new MutationObserver(() => {
    build();
    paint();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    build();
    paint();
  });
  document.fonts?.ready.then(paint);
}
