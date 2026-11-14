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
  school: string;
  degree: string;
  major: string;
  minor: string;
  gpa: string;
  /** "YYYY-MM", as an <input type="month"> gives it. */
  graduationDate: string;
  linkedin: string;
  github: string;
  portfolio: string;
  /** "Yes", "No" or "" when not set. */
  workAuthorized: string;
  needsSponsorship: string;
  /** When the person can start, as they'd write it: "May 2027". */
  startDate: string;
  demographics: Demographics;
}

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
    school: "",
    degree: "",
    major: "",
    minor: "",
    gpa: "",
    graduationDate: "",
    linkedin: "",
    github: "",
    portfolio: "",
    workAuthorized: "",
    needsSponsorship: "",
    startDate: "",
    // Every demographic question defaults to declining.
    demographics: { gender: DECLINE, hispanicLatino: DECLINE, race: DECLINE, veteran: DECLINE, disability: DECLINE },
  };
}

/** Fill in any field an older saved profile is missing, so new fields get their defaults. */
export function withDefaults(saved: Partial<Profile> | undefined): Profile {
  const base = emptyProfile();
  if (!saved) return base;
  return { ...base, ...saved, demographics: { ...base.demographics, ...(saved.demographics ?? {}) } };
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

/** The parts of a "YYYY-MM" graduation date, for forms that ask for month and year apart. */
export function graduationParts(value: string): { year: string; month: string; monthName: string } {
  const [year = "", month = ""] = value.split("-");
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const index = Number(month) - 1;
  return { year, month, monthName: index >= 0 && index < 12 ? names[index] : "" };
}
