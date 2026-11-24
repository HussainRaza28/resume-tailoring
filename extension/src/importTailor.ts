/**
 * "Import from Tailor": read the profile the Tailor app exports (Settings,
 * Export for Autofill), work out what it would change, and merge it in.
 *
 * The resume is the source for what it holds: contact details, links, roles,
 * schools, skills and facts replace what's here when the file has them. What a
 * resume doesn't hold (address, work authorization, the common answers, the
 * self-identification answers, languages) is kept as it is. Nothing is saved
 * until the person presses Apply, and everything stays editable afterwards.
 */
import { type EducationEntry, type Profile, type WorkEntry, emptyEducation, emptyWork, monthParts } from "./profile";

export const FORMAT = "tailor-autofill-profile";

export interface TailorExport {
  profile: Partial<Pick<Profile, "firstName" | "lastName" | "email" | "phone" | "linkedin" | "github" | "portfolio" | "websites" | "skills">> & {
    work?: Partial<WorkEntry>[];
    education?: Partial<EducationEntry>[];
  };
  facts: string[];
}

/** Read the exported file. Throws a message for the person when it isn't one. */
export function parseTailorExport(text: string): TailorExport {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't JSON. Export it again from Tailor: Settings, Export for Autofill.");
  }
  const d = data as { format?: string; version?: number; profile?: unknown; facts?: unknown };
  if (!d || d.format !== FORMAT || typeof d.profile !== "object" || d.profile === null) {
    throw new Error("That isn't a Tailor Autofill profile. Export one from Tailor: Settings, Export for Autofill.");
  }
  if ((d.version ?? 1) > 1) throw new Error("That profile is from a newer Tailor. Update the extension, then import it again.");
  const facts = Array.isArray(d.facts) ? d.facts.filter((f): f is string => typeof f === "string") : [];
  return { profile: d.profile as TailorExport["profile"], facts };
}

const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.trim() !== "") : []);
const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");

/** The profile after the import. */
export function mergeImport(current: Profile, data: TailorExport): Profile {
  const p = data.profile;
  const next: Profile = structuredClone(current);
  for (const key of ["firstName", "lastName", "email", "phone", "linkedin", "github", "portfolio"] as const) {
    if (str(p[key])) next[key] = str(p[key]);
  }
  if (strings(p.websites).length) next.websites = strings(p.websites);
  if (strings(p.skills).length) next.skills = strings(p.skills);
  if (Array.isArray(p.work) && p.work.length) {
    next.work = p.work.map((w) => ({
      ...emptyWork(),
      title: str(w.title),
      company: str(w.company),
      location: str(w.location),
      current: Boolean(w.current),
      start: str(w.start),
      end: w.current ? "" : str(w.end),
      bullets: strings(w.bullets),
    }));
  }
  if (Array.isArray(p.education) && p.education.length) {
    next.education = p.education.map((e) => ({
      ...emptyEducation(),
      school: str(e.school),
      degree: str(e.degree),
      field: str(e.field),
      minor: str(e.minor),
      gpa: str(e.gpa),
      current: Boolean(e.current),
      start: str(e.start),
      end: str(e.end),
    }));
  }
  if (data.facts.length) next.facts = [...data.facts];
  return next;
}

export interface Change {
  label: string;
  was: string;
  now: string;
}

const LABELS: [keyof Profile, string][] = [
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["linkedin", "LinkedIn"],
  ["github", "GitHub"],
  ["portfolio", "Portfolio"],
];

/** "2025-06" as "Jun 2025". */
function shortDate(value: string): string {
  const { monthName, year } = monthParts(value);
  return monthName && year ? `${monthName.slice(0, 3)} ${year}` : year;
}

function workLine(w: WorkEntry): string {
  const dates = [shortDate(w.start), w.current ? "now" : shortDate(w.end)].filter(Boolean).join(" to ");
  return [w.title, w.company, dates].filter(Boolean).join(" · ") + (w.bullets.length ? ` (${w.bullets.length} bullets)` : "");
}

function schoolLine(e: EducationEntry): string {
  return [e.school, [e.degree, e.field].filter(Boolean).join(", "), shortDate(e.end)].filter(Boolean).join(" · ");
}

/** What the import changes, field by field and entry by entry, for the preview. */
export function changes(before: Profile, after: Profile): Change[] {
  const out: Change[] = [];
  for (const [key, label] of LABELS) {
    if (before[key] !== after[key]) out.push({ label, was: String(before[key] || ""), now: String(after[key] || "") });
  }
  const list = (label: string, a: string[], b: string[]) => {
    if (a.join("\n") !== b.join("\n")) out.push({ label, was: a.join(", "), now: b.join(", ") });
  };
  list("Other links", before.websites, after.websites);
  const rows = <T,>(label: string, a: T[], b: T[], line: (x: T) => string) => {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const was = a[i] ? line(a[i]) : "";
      const now = b[i] ? line(b[i]) : "";
      if (was !== now || JSON.stringify(a[i]) !== JSON.stringify(b[i])) out.push({ label: `${label} ${i + 1}`, was, now: now || "Removed" });
    }
  };
  rows("Role", before.work, after.work, workLine);
  rows("School", before.education, after.education, schoolLine);
  list("Skills", before.skills, after.skills);
  if (before.facts.join("\n") !== after.facts.join("\n")) {
    out.push({ label: "Facts", was: before.facts.length ? `${before.facts.length} facts` : "", now: `${after.facts.length} facts` });
  }
  return out;
}
