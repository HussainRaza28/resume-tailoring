/**
 * The profile the autofill draws on, and where it's kept.
 *
 * Everything stays in chrome.storage.local on this computer. The extension makes
 * no network calls, so none of this ever leaves the browser.
 */

export const DECLINE = "Decline to answer";

export interface Demographics {
  gender: string;
  hispanicLatino: string;
  race: string;
  veteran: string;
  disability: string;
}

/** A month and year, "YYYY-MM", as an <input type="month"> gives it. "" when not set. */
export type MonthYear = string;

export interface WorkEntry {
  title: string;
  company: string;
  location: string;
  current: boolean;
  start: MonthYear;
  end: MonthYear;
  /** The role's bullets, one per item. Workday's role description gets them one per line. */
  bullets: string[];
}

export interface EducationEntry {
  school: string;
  degree: string;
  field: string;
  minor: string;
  gpa: string;
  /** Still studying there, so ``end`` is the expected graduation. */
  current: boolean;
  start: MonthYear;
  /** Graduation, or expected graduation when ``current``. */
  end: MonthYear;
}

export interface Language {
  language: string;
  /** As the person would put it: "Native", "Fluent", "Advanced", "Intermediate", "Beginner". */
  level: string;
}

/** Answers to the questions most applications ask. Yes/No answers are "Yes", "No" or "" when not set. */
export interface Questions {
  heardFrom: string;
  /** Previously worked for the company applied to. */
  workedHereBefore: string;
  over18: string;
  willingToRelocate: string;
  /** Availability, "YYYY-MM-DD" as an <input type="date"> gives it. */
  availableFrom: string;
  availableUntil: string;
}

/**
 * The profile, in the order of Workday's My Information page: legal name and
 * preferred name, contact, address. Then experience, authorization and the
 * common questions.
 */
export interface Profile {
  /** The legal name. */
  firstName: string;
  middleName: string;
  lastName: string;
  /** Workday's "I have a preferred name": the preferred name is used only when this is ticked. */
  hasPreferredName: boolean;
  preferredFirstName: string;
  preferredLastName: string;
  email: string;
  /** "Mobile", "Home" or "Work". */
  phoneType: string;
  /** The country for the phone number's code, such as "United States" for +1. */
  phoneCountry: string;
  phone: string;
  phoneExtension: string;
  country: string;
  /** Address line 1. */
  street: string;
  /** Address line 2: apartment, suite, unit. */
  street2: string;
  city: string;
  state: string;
  postalCode: string;
  county: string;
  linkedin: string;
  github: string;
  portfolio: string;
  /** Any other links, in order. */
  websites: string[];
  /** Most recent first, as on a resume. */
  work: WorkEntry[];
  /** Most recent first. The first entry answers single-school questions. */
  education: EducationEntry[];
  skills: string[];
  languages: Language[];
  /** Authorized to work in the country of the job. "Yes", "No" or "" when not set. */
  workAuthorized: string;
  /** Needs visa sponsorship now, and in the future. */
  sponsorshipNow: string;
  sponsorshipFuture: string;
  usCitizen: string;
  /** "None" unless the person holds one: "Public Trust", "Secret", "Top Secret" and so on. */
  securityClearance: string;
  questions: Questions;
  demographics: Demographics;
  /** Facts from Tailor's facts bank, kept for reference. Autofill doesn't type them anywhere. */
  facts: string[];
}

export function emptyWork(): WorkEntry {
  return { title: "", company: "", location: "", current: false, start: "", end: "", bullets: [] };
}

export function emptyEducation(): EducationEntry {
  return { school: "", degree: "", field: "", minor: "", gpa: "", current: false, start: "", end: "" };
}

export const DEFAULT_QUESTIONS: Questions = {
  heardFrom: "Job board",
  workedHereBefore: "No",
  over18: "Yes",
  willingToRelocate: "",
  availableFrom: "",
  availableUntil: "",
};

export const NO_CLEARANCE = "None";

/** The resume PDF, stored as a data: URL so it can be turned back into a File. */
export interface StoredResume {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
}

export function emptyProfile(): Profile {
  return {
    firstName: "",
    middleName: "",
    lastName: "",
    hasPreferredName: false,
    preferredFirstName: "",
    preferredLastName: "",
    email: "",
    phoneType: "Mobile",
    phoneCountry: "United States",
    phone: "",
    phoneExtension: "",
    country: "United States",
    street: "",
    street2: "",
    city: "",
    state: "",
    postalCode: "",
    county: "",
    linkedin: "",
    github: "",
    portfolio: "",
    websites: [],
    work: [],
    education: [],
    skills: [],
    languages: [],
    workAuthorized: "",
    sponsorshipNow: "",
    sponsorshipFuture: "",
    usCitizen: "",
    securityClearance: NO_CLEARANCE,
    questions: { ...DEFAULT_QUESTIONS },
    facts: [],
    // Every demographic question defaults to declining.
    demographics: { gender: DECLINE, hispanicLatino: DECLINE, race: DECLINE, veteran: DECLINE, disability: DECLINE },
  };
}

/** Fields older versions of the profile kept, and where they went. */
interface OldFields {
  // A single school, before education became a list.
  school?: string;
  degree?: string;
  major?: string;
  minor?: string;
  gpa?: string;
  graduationDate?: string;
  // One sponsorship answer, before "now" and "in the future" were split.
  needsSponsorship?: string;
  // A start date written as text ("May 2027"), before availability became dates.
  startDate?: string;
}
type OldQuestions = Partial<Questions> & { phoneType?: string; phoneCountry?: string };

/** "May 2027", "05/2027" or "2027-05" as the first of that month, "2027-05-01". "" when it can't be read. */
export function startOfMonth(text: string): string {
  const t = text.trim();
  const iso = t.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3] ?? "01"}`;
  const slash = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[2]}-${slash[1].padStart(2, "0")}-01`;
  const named = t.match(/^([A-Za-z]+)\.?\s+(\d{4})$/);
  if (named) {
    const index = MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(named[1].toLowerCase().slice(0, 3)));
    if (index >= 0) return `${named[2]}-${String(index + 1).padStart(2, "0")}-01`;
  }
  return "";
}

/**
 * Fill in any field an older saved profile is missing, so new fields get their
 * defaults, and move what older versions kept elsewhere: a single school
 * becomes the first education entry, the phone type and country move from the
 * questions to the contact details, one sponsorship answer answers both "now"
 * and "in the future", and a start date written as text becomes a date.
 */
export function withDefaults(saved: (Partial<Profile> & OldFields) | undefined): Profile {
  const base = emptyProfile();
  if (!saved) return base;
  const { school, degree, major, minor, gpa, graduationDate, needsSponsorship, startDate, ...rest } = saved;
  const { phoneType, phoneCountry, ...questions } = (saved.questions ?? {}) as OldQuestions;
  const profile: Profile = {
    ...base,
    ...rest,
    questions: { ...base.questions, ...questions },
    demographics: { ...base.demographics, ...(saved.demographics ?? {}) },
  };
  if (saved.phoneType === undefined && phoneType) profile.phoneType = phoneType;
  if (saved.phoneCountry === undefined && phoneCountry) profile.phoneCountry = phoneCountry;
  if (needsSponsorship && saved.sponsorshipNow === undefined && saved.sponsorshipFuture === undefined) {
    profile.sponsorshipNow = needsSponsorship;
    profile.sponsorshipFuture = needsSponsorship;
  }
  if (startDate && !profile.questions.availableFrom) profile.questions.availableFrom = startOfMonth(startDate);
  if (!saved.education && (school || degree || major || gpa || graduationDate)) {
    profile.education = [
      { ...emptyEducation(), school: school ?? "", degree: degree ?? "", field: major ?? "", minor: minor ?? "", gpa: gpa ?? "", end: graduationDate ?? "" },
    ];
  }
  profile.work = (profile.work ?? []).map((w) => ({ ...emptyWork(), ...w, bullets: [...(w.bullets ?? [])] }));
  profile.education = (profile.education ?? []).map((e) => ({ ...emptyEducation(), ...e }));
  return profile;
}

/** chrome.storage.local, or a stand-in with the same two methods in tests. */
export interface Store {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export const chromeStore = (): Store => chrome.storage.local;

export async function loadProfile(store: Store = chromeStore()): Promise<Profile> {
  const got = await store.get(["profile"]);
  return withDefaults(got.profile as Partial<Profile> | undefined);
}

export async function saveProfile(profile: Profile, store: Store = chromeStore()): Promise<void> {
  await store.set({ profile });
}

export async function loadResume(store: Store = chromeStore()): Promise<StoredResume | null> {
  const got = await store.get(["resume"]);
  return (got.resume as StoredResume | undefined) ?? null;
}

/** Chrome's local storage holds about 10 MB in all; a resume is far smaller. */
export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

export async function saveResume(resume: StoredResume, store: Store = chromeStore()): Promise<void> {
  if (resume.size > MAX_RESUME_BYTES) throw new Error("That PDF is over 5 MB. Export a smaller one and try again.");
  await store.set({ resume });
}

export async function removeResume(store: Store = chromeStore()): Promise<void> {
  await store.remove(["resume"]);
}

/** The stored resume as a File, ready to attach to an upload field. */
export function resumeFile(resume: StoredResume): File {
  const [, base64 = ""] = resume.dataUrl.split(",", 2);
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new File([bytes], resume.name, { type: resume.type || "application/pdf" });
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The parts of a "YYYY-MM" date, for forms that ask for month and year apart. */
export function monthParts(value: string): { year: string; month: string; monthName: string } {
  const [year = "", month = ""] = value.split("-");
  const index = Number(month) - 1;
  return { year, month, monthName: index >= 0 && index < 12 ? MONTH_NAMES[index] : "" };
}

/** The first school, which answers questions that ask about one. */
export function firstEducation(p: Profile): EducationEntry {
  return p.education[0] ?? emptyEducation();
}

/** Today as MM/DD/YYYY, for forms signed with a date. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`;
}

/** A "YYYY-MM-DD" date as MM/DD/YYYY, the way most forms write it. "" when not set. */
export function usDate(value: string): string {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
}

/** The name to put in a preferred-name field: only when the person has one. */
export function preferredName(p: Profile): { first: string; last: string } | null {
  if (!p.hasPreferredName || !(p.preferredFirstName || p.preferredLastName)) return null;
  return { first: p.preferredFirstName, last: p.preferredLastName };
}
