/**
 * What a form field asks for, and the answer from the profile.
 *
 * A field is matched to a key by the site's own field names first (see
 * sites.ts) and by its label otherwise. The label rules are in order: the
 * first that matches wins, so "First name" is tried before plain "Name".
 */
import { DECLINE, type Profile, monthParts, preferredName, today, usDate } from "../profile";

export type FieldKey =
  | "firstName"
  | "middleName"
  | "lastName"
  | "fullName"
  | "preferredFirstName"
  | "preferredLastName"
  | "email"
  | "phone"
  | "phoneExtension"
  | "street"
  | "street2"
  | "county"
  | "city"
  | "state"
  | "postalCode"
  | "country"
  | "location"
  | "school"
  | "degree"
  | "major"
  | "minor"
  | "gpa"
  | "graduationDate"
  | "graduationMonth"
  | "graduationYear"
  | "linkedin"
  | "github"
  | "portfolio"
  | "workAuthorized"
  /** "Now or in the future": yes when either is. */
  | "needsSponsorship"
  | "sponsorshipNow"
  | "sponsorshipFuture"
  | "usCitizen"
  /** The clearance level. */
  | "securityClearance"
  /** Whether there is one: Yes unless it's None. */
  | "hasClearance"
  | "willingToRelocate"
  | "currentlyEnrolled"
  | "availableFrom"
  | "availableUntil"
  | "availableFromMonth"
  | "availableFromDay"
  | "availableFromYear"
  | "gender"
  | "hispanicLatino"
  | "race"
  | "veteran"
  | "disability"
  | "resume"
  // Common questions.
  | "heardFrom"
  | "workedHereBefore"
  | "over18"
  | "phoneType"
  | "phoneCountry"
  | "skills"
  | "currentCompany"
  | "currentTitle"
  | "todayDate"
  | "todayMonth"
  | "todayDay"
  | "todayYear"
  // One work entry's fields. The n-th field asking for one of these gets the n-th entry.
  | "workTitle"
  | "workCompany"
  | "workLocation"
  | "workCurrent"
  | "workStart"
  | "workStartMonth"
  | "workStartYear"
  | "workEnd"
  | "workEndMonth"
  | "workEndYear"
  | "workDescription"
  // Education beyond the first school's name, degree, major, minor, GPA and graduation.
  | "eduStartMonth"
  | "eduStartYear"
  /** A school's start as one date ("From Date"); graduationDate is its end. */
  | "eduStart"
  /** A name the person was known by at a former job, or before a change. The profile has none. */
  | "previousName";

/** Keys answered from one work or education entry. The n-th field asking for one gets entry n. */
export const ENTRY_KEYS: Partial<Record<FieldKey, "work" | "education">> = {
  workTitle: "work",
  workCompany: "work",
  workLocation: "work",
  workCurrent: "work",
  workStart: "work",
  workStartMonth: "work",
  workStartYear: "work",
  workEnd: "work",
  workEndMonth: "work",
  workEndYear: "work",
  workDescription: "work",
  school: "education",
  degree: "education",
  major: "education",
  minor: "education",
  gpa: "education",
  graduationDate: "education",
  graduationMonth: "education",
  graduationYear: "education",
  eduStartMonth: "education",
  eduStart: "education",
  eduStartYear: "education",
};

/**
 * Keys a person may simply not have an answer for: no middle name, no
 * preferred name, no second address line. A field asking for one is skipped
 * when the profile leaves it blank, instead of being left for the person.
 */
export const OPTIONAL_KEYS = new Set<FieldKey>([
  "middleName",
  "preferredFirstName",
  "preferredLastName",
  "street2",
  "county",
  "phoneExtension",
  "availableUntil",
  "previousName",
]);

/** Label rules, most specific first. Tested against the label in lower case. */
export const LABEL_RULES: [FieldKey, RegExp][] = [
  ["resume", /\b(resume|résumé|cv)\b/],
  // Preferred before legal: "Preferred first name" has "first name" in it.
  ["preferredLastName", /preferred (last|family) name/],
  ["preferredFirstName", /preferred (first |given )?name|nick ?name/],
  ["middleName", /\bmiddle (name|initial)/],
  // "Legal Name at Time of Employment", "Former name": only for people who worked there before.
  ["previousName", /name at (the )?time of (employment|hire)|\b(former|previous|prior|other|maiden) (last )?names?\b/],
  ["firstName", /\b(first|given|legal first)[ -]?name\b|^first$/],
  ["lastName", /\b(last|family|legal last)[ -]?name\b|\bsurname\b/],
  ["email", /\be-?mail\b/],
  ["heardFrom", /how did you (hear|find|learn)|where did you (hear|find|learn)|referral source|source of (application|referral)/],
  ["workedHereBefore", /previously (worked|been employed)|ever (worked|been employed)|former employee|currently or previously (employed|worked)|worked (for|at|here)\b.*\bbefore\b/],
  ["over18", /\b18\b|eighteen|legal working age|age of majority/],
  ["phoneType", /phone (device )?type|type of phone/],
  ["phoneCountry", /(country|phone) (phone )?code|dialing code/],
  ["phoneExtension", /\bext(ension)?\b/],
  ["phone", /\b(phone|mobile|cell)\b/],
  ["linkedin", /linkedin/],
  ["github", /github/],
  ["portfolio", /portfolio|personal (web)?site|^website\b|\bwebsite url\b/],
  // "Now or in the future" asks about either; a question about one of them says which.
  ["needsSponsorship", /sponsor.*\bnow or (in the )?future|now or (in the )?future.*sponsor/],
  ["sponsorshipFuture", /sponsor.*\bfuture|future.*sponsor/],
  ["sponsorshipNow", /(currently|now|presently|at this time).*sponsor|sponsor.*\b(currently|now|at this time)\b/],
  ["needsSponsorship", /sponsor/],
  ["workAuthorized", /authori[sz]ed to work|eligible to work|work authori[sz]ation|legally (allowed|permitted) to work/],
  ["usCitizen", /\bu\.? ?s\.? citizen|citizen of the (united states|u\.? ?s)|united states citizen|\bcitizenship\b/],
  ["hasClearance", /(do|have) you (currently )?(have|hold|held|possess|obtained).*clearance|active .*clearance/],
  ["securityClearance", /clearance/],
  ["willingToRelocate", /relocat/],
  ["currentlyEnrolled", /currently enrolled|currently (a )?student|are you (a )?(current )?student|enrolled in (a|an) /],
  ["availableUntil", /available until|availability end|end date of (your )?availab|until what date|last (day|date) (you are |you're )?available/],
  ["availableFrom", /start date|available to start|earliest (possible )?start|when can you start|availab(le|ility) (start|from|date)|date available/],
  ["graduationMonth", /graduation month/],
  ["graduationYear", /graduation year|year of graduation/],
  ["graduationDate", /graduat(ion|e)( date)?|expected graduation|degree (completion|end) date/],
  ["gpa", /\bgpa\b|grade point/],
  ["school", /\b(school|university|college|institution)\b/],
  ["major", /\bmajor\b|field of study|discipline|area of study|concentration/],
  ["minor", /\bminor\b/],
  ["degree", /\bdegree\b/],
  ["hispanicLatino", /hispanic|latin[oax]/],
  ["race", /\brace\b|ethnicit/],
  ["gender", /\bgender\b|\bsex\b/],
  ["veteran", /veteran/],
  ["disability", /disabilit/],
  ["postalCode", /\bzip\b|postal|post code/],
  ["city", /\bcity\b|\btown\b/],
  ["state", /\bstate\b|province|\bregion\b/],
  ["country", /\bcountry\b/],
  ["county", /\bcounty\b/],
  ["street2", /address line 2|address 2|apartment|\bapt\b|suite|\bunit\b/],
  ["street", /street|address( line)? ?1?\b|^address$/],
  ["location", /\blocation\b|where are you (located|based)|current city/],
  ["currentCompany", /^(current|most recent|present) (company|employer)/],
  ["currentTitle", /^(current|most recent|present) (job )?title/],
  // "Company", "Organization", "Employer", "Company / Organization", "Employer name".
  ["workCompany", /^(company|organi[sz]ation|employer)( (name|organi[sz]ation|employer))?( name)?$/],
  ["workTitle", /^job title$|^title$|^position( title)?$/],
  ["skills", /^(technical )?skills\b/],
  ["fullName", /^(full |legal |your )?name\b/],
];

/** The key a label asks for, or null. */
export function keyForLabel(label: string): FieldKey | null {
  const text = normalizeLabel(label);
  const rule = LABEL_RULES.find(([, pattern]) => pattern.test(text));
  return rule ? rule[0] : null;
}

/**
 * A label in the form the rules are written for: lower case, without the
 * required-field asterisk, with slashes, colons, brackets and other punctuation
 * turned into spaces. Hyphens, apostrophes and periods stay, since "e-mail",
 * "I'm" and "U.S." need them. "* Company / Organization" becomes
 * "company organization".
 */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}\s.'-]/gu, " ")
    .replace(/(^|\s)[.'-]+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Inside a work or education section, "Start Date", "From", "End Date" and "To"
 * are that entry's dates, not when the person can start work. Null when the
 * label isn't one of those or the section isn't work or education.
 */
export function keyInSection(label: string, section: "work" | "education" | null): FieldKey | null {
  if (!section) return null;
  const text = normalizeLabel(label);
  const start = /^(start|from|begin|began)( date)?$|^date (started|from|of start)$|^(start|from) (month|year) and year$/.test(text);
  const end = /^(end|to|finish|until)( date)?( actual or expected)?$|^date (ended|to|of end)$|^(end|graduation) date( actual or expected| expected)?$/.test(text);
  if (section === "work") return start ? "workStart" : end ? "workEnd" : null;
  return start ? "eduStart" : end ? "graduationDate" : null;
}

// An open question is left for the person: "Why do you want to work here?"
const ESSAY = /^(why|describe|tell us|explain|share|please (describe|share|explain|tell))\b|cover letter|anything else|additional information/;

export function looksLikeEssay(label: string): boolean {
  const text = label.toLowerCase().trim();
  return ESSAY.test(text) || text.length > 140;
}

/**
 * The profile's answer for a key, as plain text. "" when the profile doesn't
 * have one. ``index`` picks the work or education entry for entry keys.
 */
export function valueFor(key: FieldKey, p: Profile, index = 0): string {
  const work = p.work[index];
  const edu = p.education[index];
  const now = today();
  switch (key) {
    case "fullName":
      return `${p.firstName} ${p.lastName}`.trim();
    case "previousName":
      return "";
    case "preferredFirstName":
      return preferredName(p)?.first ?? "";
    case "preferredLastName":
      return preferredName(p)?.last ?? "";
    case "needsSponsorship": {
      const both = [p.sponsorshipNow, p.sponsorshipFuture];
      return both.includes("Yes") ? "Yes" : both.includes("No") ? "No" : "";
    }
    case "hasClearance":
      return !p.securityClearance ? "" : p.securityClearance === "None" ? "No" : "Yes";
    case "currentlyEnrolled":
      return edu ? (edu.current ? "Yes" : "No") : "";
    case "willingToRelocate":
      return p.questions.willingToRelocate;
    case "availableFrom":
      return usDate(p.questions.availableFrom);
    case "availableUntil":
      return usDate(p.questions.availableUntil);
    case "availableFromMonth":
      return usDate(p.questions.availableFrom).slice(0, 2);
    case "availableFromDay":
      return usDate(p.questions.availableFrom).slice(3, 5);
    case "availableFromYear":
      return usDate(p.questions.availableFrom).slice(6);
    case "location":
      return [p.city, p.state].filter(Boolean).join(", ");
    case "school":
      return edu?.school ?? "";
    case "degree":
      return edu?.degree ?? "";
    case "major":
      return edu?.field ?? "";
    case "minor":
      return edu?.minor ?? "";
    case "gpa":
      return edu?.gpa ?? "";
    case "graduationDate":
      return slashed(edu?.end ?? "");
    case "graduationMonth":
      return monthParts(edu?.end ?? "").monthName;
    case "graduationYear":
      return monthParts(edu?.end ?? "").year;
    case "eduStartMonth":
      return monthParts(edu?.start ?? "").monthName;
    case "eduStart":
      return slashed(edu?.start ?? "");
    case "eduStartYear":
      return monthParts(edu?.start ?? "").year;
    case "workTitle":
      return work?.title ?? "";
    case "workCompany":
      return work?.company ?? "";
    case "workLocation":
      return work?.location ?? "";
    case "workCurrent":
      return work ? (work.current ? "Yes" : "No") : "";
    case "workStart":
      return slashed(work?.start ?? "");
    case "workStartMonth":
      return monthParts(work?.start ?? "").monthName;
    case "workStartYear":
      return monthParts(work?.start ?? "").year;
    case "workEnd":
      return work && !work.current ? slashed(work.end) : "";
    case "workEndMonth":
      return work && !work.current ? monthParts(work.end).monthName : "";
    case "workEndYear":
      return work && !work.current ? monthParts(work.end).year : "";
    case "workDescription":
      return work ? work.bullets.join("\n") : "";
    case "skills":
      return p.skills.join(", ");
    case "currentCompany":
    case "currentTitle": {
      // The role marked current, else the most recent one.
      const role = p.work.find((w) => w.current) ?? p.work[0];
      return (key === "currentCompany" ? role?.company : role?.title) ?? "";
    }
    case "heardFrom":
    case "workedHereBefore":
    case "over18":
      return p.questions[key];
    case "todayDate":
      return now;
    case "todayMonth":
      return now.slice(0, 2);
    case "todayDay":
      return now.slice(3, 5);
    case "todayYear":
      return now.slice(6);
    case "gender":
    case "hispanicLatino":
    case "race":
    case "veteran":
    case "disability":
      return p.demographics[key];
    case "resume":
      return "";
    default:
      return p[key];
  }
}

/** "2027-05" as "05/2027", the way forms write a month and year. */
export function slashed(value: string): string {
  const { month, year } = monthParts(value);
  return month && year ? `${month}/${year}` : "";
}

/** Plain lower-case words, for comparing a wanted answer with a form's choices. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The many ways forms say "I'd rather not answer".
const DECLINES = /decline|prefer not|don't wish|do not wish|not wish to|choose not|not to answer|not to say|not to (self )?identify|do not want to answer|i don't want to answer/;

const NO_ANSWER = /^no\b|\bi am not\b|\bi'm not\b|\bnot a\b|\bdo not have\b|\bdon't have\b|\bnone\b/;

/**
 * How well a choice on the form fits the wanted answer, 0 to 100.
 *
 * Exact text wins. Declining matches any of the usual decline wordings, and
 * Yes or No match a choice that starts with that word. Otherwise the share of
 * the wanted words that appear in the choice decides.
 */
export function choiceScore(choice: string, wanted: string): number {
  const c = normalize(choice);
  const w = normalize(wanted);
  if (!c || !w) return 0;
  if (c === w) return 100;
  if (w === normalize(DECLINE)) return DECLINES.test(c) ? 90 : 0;
  if (DECLINES.test(c)) return 0;
  if (w === "yes" || w === "no") return new RegExp(`^${w}\\b`).test(c) ? 80 : 0;
  // "I am not a protected veteran" and "No, I do not have a disability" mean no, and
  // must not match a yes. "Asian (Not Hispanic or Latino)" isn't a no answer.
  if (NO_ANSWER.test(w) !== NO_ANSWER.test(c)) return 0;
  if (c.includes(w) || w.includes(c)) return 70;
  const words = w.split(" ").filter((x) => x.length > 2);
  const shared = words.filter((x) => c.split(" ").includes(x)).length;
  return words.length ? Math.round((shared / words.length) * 60) : 0;
}

/** The best choice for the wanted answer, or -1 when nothing fits well enough. */
export function bestChoice(choices: string[], wanted: string): number {
  let best = -1;
  let bestScore = 39;
  choices.forEach((choice, i) => {
    const score = choiceScore(choice, wanted);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/**
 * For a key that holds one whole date, the profile's date as stored and
 * whether it starts or ends something, so a field that wants a day can get
 * one (dates.ts). "" means no date: a current role's end, or a date not set.
 * Null for keys that aren't a whole date.
 */
export function profileDate(key: FieldKey, p: Profile, index = 0): { text: string; role: "start" | "end" } | null {
  const work = p.work[index];
  const edu = p.education[index];
  switch (key) {
    case "workStart":
      return { text: work?.start ?? "", role: "start" };
    case "workEnd":
      return { text: work && !work.current ? work.end : "", role: "end" };
    case "eduStart":
      return { text: edu?.start ?? "", role: "start" };
    case "graduationDate":
      return { text: edu?.end ?? "", role: "end" };
    case "availableFrom":
      return { text: p.questions.availableFrom, role: "start" };
    case "availableUntil":
      return { text: p.questions.availableUntil, role: "end" };
    case "todayDate": {
      const now = new Date();
      return { text: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`, role: "start" };
    }
    default:
      return null;
  }
}
