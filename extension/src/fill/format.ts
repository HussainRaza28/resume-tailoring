/**
 * Values made ready for a form before they're typed in.
 *
 * - A link gets "https://" when it has no scheme: Workday's URL and LinkedIn
 *   fields refuse "linkedin.com/in/someone".
 * - A role description's lines each start with "• ", once: Workday's Role
 *   Description is a plain text box, so lines without a marker run together
 *   into one block when a recruiter reads them.
 */

/** "linkedin.com/in/x" as "https://linkedin.com/in/x". A link with any scheme, or nothing, is kept. */
export function withScheme(url: string): string {
  const t = (url ?? "").trim();
  if (!t) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z0-9.-]+:\d/i.test(t)) return t;
  return `https://${t.replace(/^\/+/, "")}`;
}

// A line that already starts with a bullet, dash, star or a number like "1." or "2)".
const MARKED = /^\s*(?:[•·▪◦‣●○■□➢►–—*-]|\d+[.)])\s*/;

/** Each non-empty line prefixed with "• ", unless it already starts with a bullet, dash or number. */
export function bulletLines(lines: string[] | string): string {
  const all = Array.isArray(lines) ? lines.flatMap((l) => l.split(/\r?\n/)) : lines.split(/\r?\n/);
  return all
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (MARKED.test(l) ? l : `• ${l}`))
    .join("\n");
}
