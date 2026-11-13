/** Number and time formatting for the UI. Missing values print as an en dash. */

const DASH = "–";

export function money(usd: number | null | undefined): string {
  if (usd == null || Number.isNaN(usd)) return DASH;
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function tokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return DASH;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m} m ${r} s` : `${m} m`;
  return `${Math.floor(m / 60)} h ${m % 60} m`;
}

/** Stopwatch display, e.g. 04:07 or 1:02:09. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function pct(x: number | null | undefined, digits = 0): string {
  if (x == null || Number.isNaN(x)) return DASH;
  return `${(x * 100).toFixed(digits)}%`;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Signed delta, e.g. "+12", "0", "-3". */
export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
