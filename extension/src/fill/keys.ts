/**
 * What a form field asks for, and the answer from the profile.
 *
 * A field is matched to a key by the site's own field names first (see
 * sites.ts) and by its label otherwise. The label rules are in order: the
 * first that matches wins, so "First name" is tried before plain "Name".
 */
import { DECLINE, type Profile, monthParts, today } from "../profile";

export type FieldKey =
  | "firstName"
  | "lastName"
  | "fullName"
  | "email"
  | "phone"
  | "street"
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
  | "needsSponsorship"
  | "startDate"
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
  | "eduStartYear";

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
  eduStartYear: "education",
};

/** Label rules, most specific first. Tested against the label in lower case. */
export const LABEL_RULES: [FieldKey, RegExp][] = [
  ["resume", /\b(resume|résumé|cv)\b/],
  ["firstName", /\b(first|given|legal first)[ -]?name\b|^first$/],
  ["lastName", /\b(last|family|legal last)[ -]?name\b|\bsurname\b/],
  ["email", /\be-?mail\b/],
  ["heardFrom", /how did you (hear|find|learn)|where did you (hear|find|learn)|referral source|source of (application|referral)/],
  ["workedHereBefore", /previously (worked|been employed)|ever (worked|been employed)|former employee|currently or previously (employed|worked)|worked (for|at|here)\b.*\bbefore\b/],
  ["over18", /\b18\b|eighteen|legal working age|age of majority/],
  ["phoneType", /phone (device )?type|type of phone/],
  ["phoneCountry", /(country|phone) (phone )?code|dialing code/],
  ["phone", /\b(phone|mobile|cell)\b/],
  ["linkedin", /linkedin/],
  ["github", /github/],
  ["portfolio", /portfolio|personal (web)?site|^website\b|\bwebsite url\b/],
  ["needsSponsorship", /sponsor/],
  ["workAuthorized", /authori[sz]ed to work|eligible to work|work authori[sz]ation|legally (allowed|permitted) to work/],
  ["startDate", /start date|available to start|earliest (possible )?start|when can you start/],
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
  ["street", /street|address( line)? ?1?\b|^address$/],
  ["location", /\blocation\b|where are you (located|based)|current city/],
  ["currentCompany", /^(current|most recent|present) (company|employer)/],
  ["currentTitle", /^(current|most recent|present) (job )?title/],
  ["workCompany", /^(company|employer)( name)?$/],
  ["workTitle", /^job title$|^title$|^position( title)?$/],
  ["skills", /^(technical )?skills\b/],
  ["fullName", /^(full |legal |your )?name\b/],
];

/** The key a label asks for, or null. */
export function keyForLabel(label: string): FieldKey | null {
  const text = label.toLowerCase();
  const rule = LABEL_RULES.find(([, pattern]) => pattern.test(text));
  return rule ? rule[0] : null;
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
    case "phoneType":
      return p.questions[key];
    case "phoneCountry":
      return p.questions.phoneCountry;
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
