/**
 * The job sites the autofill knows by name.
 *
 * Each site's own field ids and names are more reliable than its labels, so
 * they're tried first. Anything a site doesn't name here, and every field on a
 * site not listed, is matched by its label instead (keys.ts).
 */
import type { Profile } from "../profile";
import type { FillReport } from "./engine";
import { type FieldKey, keyForLabel } from "./keys";
import { addSuccessFactorsRows } from "./successfactors";
import { workdayAfter, workdayBefore } from "./workday";
import { workdayLabel } from "./workdayWidgets";

export interface Site {
  name: string;
  matches(url: URL): boolean;
  /** The key for a field, from its id, name or other attributes. Null to fall back to the label. */
  keyFor(el: HTMLElement): FieldKey | null;
  /**
   * Fill the parts of the page the general pass can't, before it runs, and add
   * every field touched to ``handled`` so the general pass leaves them alone.
   */
  before?(root: ParentNode, profile: Profile, resume: File | null, report: FillReport, handled: Set<HTMLElement>): Promise<void>;
  /** The part of the page that holds the application, when the page has more forms (a job search box). */
  formRoot?(root: ParentNode): ParentNode | null;
  /** The field's name for the fill report, when the site knows a better one than its label (never its value). */
  reportLabel?(el: HTMLElement): string;
  /** Check the page once the general pass is done, such as for fields the site flags as not accepted. */
  after?(root: ParentNode, report: FillReport): Promise<void>;
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
    // Employment and education entries, classic names first, then the newer boards' ids.
    [/employments\]\[\]\[company_name\]|employment_company_name|company-name-\d/, "workCompany"],
    [/employments\]\[\]\[title\]|employment_title|(^|\s)title-\d/, "workTitle"],
    [/employments\]\[\]\[start_date\]\[month\]|employment_start_date_month|start-date-month-\d/, "workStartMonth"],
    [/employments\]\[\]\[start_date\]\[year\]|employment_start_date_year|start-date-year-\d/, "workStartYear"],
    [/employments\]\[\]\[end_date\]\[month\]|employment_end_date_month|end-date-month-\d/, "workEndMonth"],
    [/employments\]\[\]\[end_date\]\[year\]|employment_end_date_year|end-date-year-\d/, "workEndYear"],
    [/employments\]\[\]\[current\]|employment_current|current-role-\d/, "workCurrent"],
    [/educations\]\[\]\[start_date\]\[month\]|education_start_date_month|start-month--\d/, "eduStartMonth"],
    [/educations\]\[\]\[start_date\]\[year\]|education_start_date_year|start-year--\d/, "eduStartYear"],
    [/educations\]\[\]\[end_date\]\[month\]|education_end_date_month|end-month--\d/, "graduationMonth"],
    [/educations\]\[\]\[end_date\]\[year\]|education_end_date_year|end-year--\d/, "graduationYear"],
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
      org: "currentCompany",
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
  // Older pages name fields legalNameSection_firstName, newer ones name--legalName--firstName.
  [/preferrednamesection_firstname|preferredname--firstname/, "preferredFirstName"],
  [/preferrednamesection_lastname|preferredname--lastname/, "preferredLastName"],
  [/legalnamesection_firstname|legalname--firstname/, "firstName"],
  [/legalnamesection_middlename|legalname--middlename/, "middleName"],
  [/legalnamesection_lastname|legalname--lastname/, "lastName"],
  [/^email$|emailaddress|--email$/, "email"],
  [/phone-device-type|devicetype|phonetype/, "phoneType"],
  [/countryphonecode|phonecode/, "phoneCountry"],
  [/phone-extension|phonenumber--extension|--extension$/, "phoneExtension"],
  [/phone-number|phonenumber--phonenumber|--phonenumber$/, "phone"],
  [/addresssection_addressline1|address--addressline1/, "street"],
  [/addresssection_addressline2|address--addressline2/, "street2"],
  [/regionsubdivision1|addresssection_county|address--county/, "county"],
  [/addresssection_city|address--city/, "city"],
  [/addresssection_postalcode|address--postalcode/, "postalCode"],
  [/addresssection_countryregion|address--countryregion/, "state"],
  [/countrydropdown|country--country/, "country"],
  [/sourceprompt|source--source|howdidyouhear/, "heardFrom"],
  [/candidateispreviousworker|previousworker/, "workedHereBefore"],
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

/** The parts of a date box Workday splits into month, day and year. */
const DATE_PARTS: Record<string, FieldKey> = {
  "datesectionmonth-input": "todayMonth",
  "datesectionday-input": "todayDay",
  "datesectionyear-input": "todayYear",
};

export const workday: Site = {
  name: "Workday",
  matches: (url) => /(^|\.)(myworkdayjobs|myworkday|myworkdaysite)\.com$/.test(url.hostname),
  keyFor: (el) => {
    const own = [el.getAttribute("data-automation-id") ?? "", el.id].map((x) => x.toLowerCase());
    // The signature date on the disability form: today, whole or in parts.
    if (el.closest("[id*='dateSignedOn' i], [data-automation-id*='dateSignedOn' i]")) {
      return DATE_PARTS[own[0]] ?? (el instanceof HTMLInputElement && el.type !== "checkbox" ? "todayDate" : null);
    }
    // A split date box elsewhere, such as "When are you available to start?": the question decides.
    if (DATE_PARTS[own[0]]) {
      const field = el.closest("[data-automation-id^='formField-']");
      const question = field?.querySelector("label, legend")?.textContent ?? "";
      if (keyForLabel(question) !== "availableFrom") return null;
      return ({ todayMonth: "availableFromMonth", todayDay: "availableFromDay", todayYear: "availableFromYear" } as const)[
        DATE_PARTS[own[0]] as "todayMonth" | "todayDay" | "todayYear"
      ];
    }
    // Then the field's own names, then its formField-* wrapper's (a search box has a generic name of its own).
    const wrapper = el.closest("[data-automation-id^='formField-']")?.getAttribute("data-automation-id")?.slice("formField-".length).toLowerCase() ?? "";
    for (const names of [own, [wrapper]]) {
      for (const [pattern, key] of WORKDAY_FIELDS) {
        if (names.some((n) => n && pattern.test(n))) return key;
      }
    }
    // The disability form is a list of checkboxes under a generic question. Only the
    // checkboxes count: the page's name and date fields have "disability" in their ids too.
    const isChoice = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
    if (isChoice && el.closest("[data-automation-id*='disability' i], [id*='disability' i]")) return "disability";
    return null;
  },
  before: workdayBefore,
  after: workdayAfter,
  reportLabel: workdayLabel,
};

/**
 * SAP SuccessFactors career sites: <company>.jobs.hr.cloud.sap and the older
 * successfactors.com and sapsf hosts. Built-in fields carry a name (firstName,
 * cellPhone, zip); the company's own fields are numbered (VFLD2 is the company
 * in Work Experience and the degree in Education), so those go by their labels.
 * Dates are SAP UI5 date picker web components (dom.ts).
 */
export const successFactors: Site = {
  name: "SuccessFactors",
  matches: (url) => /(^|\.)(jobs\.hr\.cloud\.sap|successfactors\.(com|eu)|sapsf\.(com|eu))$/.test(url.hostname),
  keyFor: (el) => {
    const named: Record<string, FieldKey> = {
      firstName: "firstName",
      middleName: "middleName",
      lastName: "lastName",
      knownAs: "preferredFirstName",
      cellPhone: "phone",
      homePhone: "phone",
      contactEmail: "email",
      address: "street",
      address2: "street2",
      city: "city",
      zip: "postalCode",
    };
    return named[el.getAttribute("name") ?? ""] ?? null;
  },
  before: addSuccessFactorsRows,
  // The application is form#careerform; the page's job search and language picker sit outside it.
  formRoot: (root) => root.querySelector("form#careerform, form[name='careerform'], #rcmJobApplicationCtr"),
};

export const SITES: Site[] = [greenhouse, lever, ashby, workday, successFactors];

/** The known site for a page address, or null for "match by label only". */
export function siteFor(href: string): Site | null {
  try {
    const url = new URL(href);
    return SITES.find((s) => s.matches(url)) ?? null;
  } catch {
    return null;
  }
}
