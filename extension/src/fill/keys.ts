/**
 * What a form field asks for, and the answer from the profile.
 *
 * A field is matched to a key by the site's own field names first (see
 * sites.ts) and by its label otherwise. The label rules are in order: the
 * first that matches wins, so "First name" is tried before plain "Name".
 */
import { DECLINE, type Profile, graduationParts } from "../profile";

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
  | "resume";

/** Label rules, most specific first. Tested against the label in lower case. */
export const LABEL_RULES: [FieldKey, RegExp][] = [
  ["resume", /\b(resume|résumé|cv)\b/],
  ["firstName", /\b(first|given|legal first)[ -]?name\b|^first$/],
  ["lastName", /\b(last|family|legal last)[ -]?name\b|\bsurname\b/],
  ["email", /\be-?mail\b/],
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

/** The profile's answer for a key, as plain text. "" when the profile doesn't have one. */
export function valueFor(key: FieldKey, p: Profile): string {
  const grad = graduationParts(p.graduationDate);
  switch (key) {
    case "fullName":
      return `${p.firstName} ${p.lastName}`.trim();
    case "location":
      return [p.city, p.state].filter(Boolean).join(", ");
    case "graduationDate":
      return grad.monthName && grad.year ? `${grad.month}/${grad.year}` : "";
    case "graduationMonth":
      return grad.monthName;
    case "graduationYear":
      return grad.year;
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
