/**
 * The job sites the autofill knows by name.
 *
 * Each site's own field ids and names are more reliable than its labels, so
 * they're tried first. Anything a site doesn't name here, and every field on a
 * site not listed, is matched by its label instead (keys.ts).
 */
import type { FieldKey } from "./keys";

export interface Site {
  name: string;
  matches(url: URL): boolean;
  /** The key for a field, from its id, name or other attributes. Null to fall back to the label. */
  keyFor(el: HTMLElement): FieldKey | null;
}

function idOrName(el: HTMLElement): string {
  return `${el.id} ${el.getAttribute("name") ?? ""}`.toLowerCase();
}

/** First rule whose pattern matches the field's id or name. */
function byPattern(rules: [RegExp, FieldKey][]): (el: HTMLElement) => FieldKey | null {
  return (el) => {
    const s = idOrName(el);
    return rules.find(([pattern]) => pattern.test(s))?.[1] ?? null;
  };
}

/** Greenhouse: classic boards (boards.greenhouse.io) and the newer job-boards.greenhouse.io use the same ids. */
export const greenhouse: Site = {
  name: "Greenhouse",
  matches: (url) => url.hostname.endsWith("greenhouse.io"),
  keyFor: byPattern([
    [/\bfirst_name\b/, "firstName"],
    [/\blast_name\b/, "lastName"],
    [/(^|\s)email\b|\[email\]/, "email"],
    [/(^|\s)phone\b|\[phone\]/, "phone"],
    [/(^|\s)resume\b|\[resume\]/, "resume"],
    [/job_application\[location\]|candidate-location|job_application_location/, "location"],
    [/education_school_name|school--\d|\[school_name_id\]/, "school"],
    [/education_degree|degree--\d|\[degree_id\]/, "degree"],
    [/education_discipline|discipline--\d|\[discipline_id\]/, "major"],
    [/hispanic_ethnicity/, "hispanicLatino"],
    [/(^|_|\[|\s)gender\b/, "gender"],
    [/(^|_|\[|\s)race\b/, "race"],
    [/veteran_status/, "veteran"],
    [/disability_status/, "disability"],
  ]),
};

/** Lever: jobs.lever.co/<company>/<id>/apply. Fields are named, the custom questions are "cards". */
export const lever: Site = {
  name: "Lever",
  matches: (url) => url.hostname === "jobs.lever.co" || url.hostname.endsWith(".lever.co"),
  keyFor: (el) => {
    const name = el.getAttribute("name") ?? "";
    const named: Record<string, FieldKey> = {
      name: "fullName",
      email: "email",
      phone: "phone",
      location: "location",
      resume: "resume",
      "urls[LinkedIn]": "linkedin",
      "urls[GitHub]": "github",
      "urls[Github]": "github",
      "urls[Portfolio]": "portfolio",
      "eeo[gender]": "gender",
      "eeo[race]": "race",
      "eeo[veteran]": "veteran",
      "eeo[disability]": "disability",
    };
    return named[name] ?? null;
  },
};

/** Ashby: jobs.ashbyhq.com/<company>/<id>/application. Built-in fields are named _systemfield_*. */
export const ashby: Site = {
  name: "Ashby",
  matches: (url) => url.hostname === "jobs.ashbyhq.com",
  keyFor: byPattern([
    [/_systemfield_name\b/, "fullName"],
    [/_systemfield_email\b/, "email"],
    [/_systemfield_phone/, "phone"],
    [/_systemfield_resume\b/, "resume"],
    [/_systemfield_location\b/, "location"],
  ]),
};

export const SITES: Site[] = [greenhouse, lever, ashby];

/** The known site for a page address, or null for "match by label only". */
export function siteFor(href: string): Site | null {
  try {
    const url = new URL(href);
    return SITES.find((s) => s.matches(url)) ?? null;
  } catch {
    return null;
  }
}
