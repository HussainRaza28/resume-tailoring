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

/**
 * Workday: <company>.wd5.myworkdayjobs.com and similar. Fields carry a
 * data-automation-id (older pages) or an id such as name--legalName--firstName
 * (newer ones). An application is several pages; Autofill fills the page that's
 * showing, and the person moves on with Workday's own "Save and Continue".
 * Dropdowns are buttons that open a list of options (handled in dom.ts).
 */
const WORKDAY_FIELDS: [RegExp, FieldKey][] = [
  [/legalnamesection_firstname|legalname--firstname/, "firstName"],
  [/legalnamesection_lastname|legalname--lastname/, "lastName"],
  [/^email$|emailaddress|--email$/, "email"],
  [/phone-number|phonenumber--phonenumber|--phonenumber$/, "phone"],
  [/addresssection_addressline1|address--addressline1/, "street"],
  [/addresssection_city|address--city/, "city"],
  [/addresssection_postalcode|address--postalcode/, "postalCode"],
  [/addresssection_countryregion|address--countryregion/, "state"],
  [/countrydropdown|country--country/, "country"],
  [/file-upload-input-ref/, "resume"],
  [/linkedinquestion|linkedin/, "linkedin"],
  [/(^|--)school(name)?$|schoolname/, "school"],
  [/(^|--)degree$/, "degree"],
  [/fieldofstudy/, "major"],
  [/(^|--)gpa$|gradeaverage/, "gpa"],
  [/hispanicorlatino/, "hispanicLatino"],
  [/ethnicitydropdown|ethnicity/, "race"],
  [/(^|--|personalinfous--)gender$/, "gender"],
  [/veteranstatus/, "veteran"],
];

export const workday: Site = {
  name: "Workday",
  matches: (url) => /(^|\.)(myworkdayjobs|myworkday|myworkdaysite)\.com$/.test(url.hostname),
  keyFor: (el) => {
    const names = [el.getAttribute("data-automation-id") ?? "", el.id].map((x) => x.toLowerCase());
    for (const [pattern, key] of WORKDAY_FIELDS) {
      if (names.some((n) => n && pattern.test(n))) return key;
    }
    // The disability form is a list of checkboxes under a generic question. Only the
    // checkboxes count: the page's name and date fields have "disability" in their ids too.
    const isChoice = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
    if (isChoice && el.closest("[data-automation-id*='disability' i], [id*='disability' i]")) return "disability";
    return null;
  },
};

export const SITES: Site[] = [greenhouse, lever, ashby, workday];

/** The known site for a page address, or null for "match by label only". */
export function siteFor(href: string): Site | null {
  try {
    const url = new URL(href);
    return SITES.find((s) => s.matches(url)) ?? null;
  } catch {
    return null;
  }
}
