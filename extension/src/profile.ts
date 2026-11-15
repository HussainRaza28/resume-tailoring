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
  start: MonthYear;
  /** Graduation, or expected graduation. */
  end: MonthYear;
}

export interface Language {
  language: string;
  /** As the person would put it: "Native", "Fluent", "Advanced", "Intermediate", "Beginner". */
  level: string;
}

/** Answers to the questions most applications ask. */
export interface Questions {
  heardFrom: string;
  /** "Yes" or "No". */
  workedHereBefore: string;
  over18: string;
  phoneType: string;
  /** The country for the phone number's code, such as "United States" for +1. */
  phoneCountry: string;
}

export interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
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
  /** "Yes", "No" or "" when not set. */
  workAuthorized: string;
  needsSponsorship: string;
  /** When the person can start, as they'd write it: "May 2027". */
  startDate: string;
  questions: Questions;
  demographics: Demographics;
}

export function emptyWork(): WorkEntry {
  return { title: "", company: "", location: "", current: false, start: "", end: "", bullets: [] };
}

export function emptyEducation(): EducationEntry {
  return { school: "", degree: "", field: "", minor: "", gpa: "", start: "", end: "" };
}

export const DEFAULT_QUESTIONS: Questions = {
  heardFrom: "Job board",
  workedHereBefore: "No",
  over18: "Yes",
  phoneType: "Mobile",
  phoneCountry: "United States",
};

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
    lastName: "",
    email: "",
    phone: "",
    street: "",
    city: "",
    state: "",
    postalCode: "",
    country: "United States",
    linkedin: "",
    github: "",
    portfolio: "",
    websites: [],
    work: [],
    education: [],
    skills: [],
    languages: [],
    workAuthorized: "",
    needsSponsorship: "",
    startDate: "",
    questions: { ...DEFAULT_QUESTIONS },
    // Every demographic question defaults to declining.
    demographics: { gender: DECLINE, hispanicLatino: DECLINE, race: DECLINE, veteran: DECLINE, disability: DECLINE },
  };
}

/** The single school an older profile kept in flat fields. */
interface OldEducation {
  school?: string;
  degree?: string;
  major?: string;
  minor?: string;
  gpa?: string;
  graduationDate?: string;
}

/**
 * Fill in any field an older saved profile is missing, so new fields get their
 * defaults. A profile from before education became a list keeps its one school
 * as the first entry.
 */
export function withDefaults(saved: (Partial<Profile> & OldEducation) | undefined): Profile {
  const base = emptyProfile();
  if (!saved) return base;
  const { school, degree, major, minor, gpa, graduationDate, ...rest } = saved;
  const profile: Profile = {
    ...base,
    ...rest,
    questions: { ...base.questions, ...(saved.questions ?? {}) },
    demographics: { ...base.demographics, ...(saved.demographics ?? {}) },
  };
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

/** The parts of a "YYYY-MM" date, for forms that ask for month and year apart. */
export function monthParts(value: string): { year: string; month: string; monthName: string } {
  const [year = "", month = ""] = value.split("-");
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const index = Number(month) - 1;
  return { year, month, monthName: index >= 0 && index < 12 ? names[index] : "" };
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
