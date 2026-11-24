import { describe, expect, it } from "vitest";
import {
  DECLINE,
  MAX_RESUME_BYTES,
  type Store,
  emptyProfile,
  monthParts,
  startOfMonth,
  today,
  loadProfile,
  loadResume,
  removeResume,
  resumeFile,
  saveProfile,
  saveResume,
  withDefaults,
} from "../src/profile";
import { readForm, renderForm } from "../src/profileForm";

/** chrome.storage.local's three methods, over a plain object. */
function memoryStore(): Store & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const k of keys) delete data[k];
    },
  };
}

/** jsdom's File has no arrayBuffer(), so read it the older way. */
function bytesOf(file: File): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

describe("profile", () => {
  it("defaults every demographic answer to declining", () => {
    expect(Object.values(emptyProfile().demographics)).toEqual([DECLINE, DECLINE, DECLINE, DECLINE, DECLINE]);
  });

  it("fills in fields an older saved profile is missing", () => {
    const p = withDefaults({ firstName: "Jordan", demographics: { gender: "Female" } as never });
    expect(p.firstName).toBe("Jordan");
    expect(p.demographics.gender).toBe("Female");
    expect(p.demographics.veteran).toBe(DECLINE);
    expect(p.country).toBe("United States");
  });

  it("saves and loads through storage", async () => {
    const store = memoryStore();
    expect((await loadProfile(store)).firstName).toBe("");
    await saveProfile({ ...emptyProfile(), firstName: "Jordan", email: "jordan@example.com" }, store);
    expect(await loadProfile(store)).toMatchObject({ firstName: "Jordan", email: "jordan@example.com" });
  });

  it("keeps the resume and turns it back into the same file", async () => {
    const store = memoryStore();
    const bytes = new TextEncoder().encode("%PDF-1.7 sample");
    const dataUrl = `data:application/pdf;base64,${btoa(String.fromCharCode(...bytes))}`;
    await saveResume({ name: "Jordan_Sample.pdf", type: "application/pdf", size: bytes.length, dataUrl }, store);
    const file = resumeFile((await loadResume(store))!);
    expect(file.name).toBe("Jordan_Sample.pdf");
    expect(file.type).toBe("application/pdf");
    expect(Array.from(await bytesOf(file))).toEqual(Array.from(bytes));
    await removeResume(store);
    expect(await loadResume(store)).toBeNull();
  });

  it("refuses a resume too big for the browser's storage", async () => {
    const big = { name: "big.pdf", type: "application/pdf", size: MAX_RESUME_BYTES + 1, dataUrl: "data:," };
    await expect(saveResume(big, memoryStore())).rejects.toThrow(/over 5 MB/);
  });

  it("splits a graduation date for forms that ask for month and year", () => {
    expect(monthParts("2027-05")).toEqual({ year: "2027", month: "05", monthName: "May" });
    expect(monthParts("")).toEqual({ year: "", month: "", monthName: "" });
    expect(today(new Date(2026, 10, 5))).toBe("11/05/2026");
  });
});

describe("profile form", () => {
  const field = (form: HTMLFormElement, key: string) => form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-key="${key}"]`)!;

  it("shows the profile, and reads back what was typed", () => {
    const form = document.createElement("form");
    renderForm(form, { ...emptyProfile(), firstName: "Jordan", skills: ["Python", "SQL"] });
    expect(field(form, "firstName").value).toBe("Jordan");
    expect(field(form, "gender").value).toBe(DECLINE);
    expect(field(form, "skills").value).toBe("Python\nSQL");
    expect(field(form, "heardFrom").value).toBe("Job board");
    expect(field(form, "workedHereBefore").value).toBe("No");
    expect(field(form, "over18").value).toBe("Yes");
    expect(field(form, "phoneType").value).toBe("Mobile");

    field(form, "lastName").value = "  Sample ";
    field(form, "sponsorshipFuture").value = "No";
    field(form, "race").value = "Asian";
    field(form, "skills").value = "Python, SQL\nDocker, python";
    field(form, "websites").value = "https://a.example\n\nhttps://b.example";
    const read = readForm(form, emptyProfile());
    expect(read).toMatchObject({ firstName: "Jordan", lastName: "Sample", sponsorshipFuture: "No" });
    expect(read.skills).toEqual(["Python", "SQL", "Docker"]);
    expect(read.websites).toEqual(["https://a.example", "https://b.example"]);
    expect(read.demographics).toMatchObject({ race: "Asian", gender: DECLINE });
  });

  it("shows the preferred name fields only while the box is ticked, and reads them back", () => {
    const form = document.createElement("form");
    // A checkbox only fires change while it's in the page.
    document.body.replaceChildren(form);
    renderForm(form, emptyProfile());
    const box = field(form, "hasPreferredName") as HTMLInputElement;
    const first = field(form, "preferredFirstName");
    expect(box.checked).toBe(false);
    expect(first.closest("label")!.hidden).toBe(true);
    box.click();
    expect(first.closest("label")!.hidden).toBe(false);
    first.value = "Jo";
    expect(readForm(form, emptyProfile())).toMatchObject({ hasPreferredName: true, preferredFirstName: "Jo" });
  });

  it("orders the top like Workday's My Information: legal name, preferred name, contact, address", () => {
    const form = document.createElement("form");
    renderForm(form, emptyProfile());
    const keys = Array.from(form.querySelectorAll<HTMLElement>("[data-key]")).map((el) => el.dataset.key);
    expect(keys.slice(0, 18)).toEqual([
      "firstName", "middleName", "lastName", "hasPreferredName", "preferredFirstName", "preferredLastName",
      "email", "phoneType", "phoneCountry", "phone", "phoneExtension",
      "country", "street", "street2", "city", "state", "postalCode", "county",
    ]);
    expect(field(form, "securityClearance").value).toBe("None");
    expect(field(form, "availableFrom").getAttribute("type")).toBe("date");
  });

  it("marks a school as currently enrolled, which makes its end the expected graduation", () => {
    const form = document.createElement("form");
    // A checkbox only fires change while it's in the page.
    document.body.replaceChildren(form);
    renderForm(form, { ...emptyProfile(), education: [{ school: "State University", degree: "", field: "", minor: "", gpa: "", current: false, start: "", end: "2027-05" }] });
    const entry = form.querySelector<HTMLElement>(".entry[data-kind='education']")!;
    const enrolled = entry.querySelector<HTMLInputElement>("[data-field='current']")!;
    const endLabel = entry.querySelector<HTMLInputElement>("[data-field='end']")!.closest("label")!;
    expect(endLabel.textContent).toContain("Graduation");
    enrolled.click();
    expect(endLabel.textContent).toContain("Expected graduation");
    expect(readForm(form, emptyProfile()).education[0]).toMatchObject({ current: true, end: "2027-05" });
  });

  it("has a field for every plain value the autofill uses", () => {
    const form = document.createElement("form");
    renderForm(form, emptyProfile());
    const keys = Array.from(form.querySelectorAll<HTMLElement>("[data-key]")).map((el) => el.dataset.key);
    const lists = ["work", "education", "languages", "questions", "demographics"];
    const expected = [
      ...Object.keys(emptyProfile()).filter((k) => !lists.includes(k)),
      ...Object.keys(emptyProfile().questions),
      ...Object.keys(emptyProfile().demographics),
    ];
    expect(keys.sort()).toEqual(expected.sort());
  });

  it("adds, edits, reorders and removes work entries", () => {
    const form = document.createElement("form");
    document.body.replaceChildren(form);
    renderForm(form, { ...emptyProfile(), work: [{ title: "Intern", company: "Northwind", location: "", current: false, start: "2025-06", end: "2025-08", bullets: ["Built a thing"] }] });
    const list = form.querySelector<HTMLElement>("[data-list='work']")!;
    list.querySelector<HTMLButtonElement>(".entry-add")!.click();
    const entries = () => Array.from(list.querySelectorAll<HTMLElement>(".entry"));
    expect(entries()).toHaveLength(2);
    const second = entries()[1];
    const set = (entry: HTMLElement, name: string, value: string) => {
      const el = entry.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-field='${name}']`)!;
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set(second, "title", "Assistant");
    set(second, "company", "Library");
    set(second, "bullets", "- Helped patrons\n\n• Set up laptops");
    const current = second.querySelector<HTMLInputElement>("[data-field='current']")!;
    current.click();
    expect(second.querySelector<HTMLInputElement>("[data-field='end']")!.disabled).toBe(true);
    expect(second.querySelector("strong")!.textContent).toBe("Assistant · Library");

    // Move the second role up, then read everything back.
    second.querySelector<HTMLButtonElement>("[aria-label='Move up']")!.click();
    let read = readForm(form, emptyProfile());
    expect(read.work.map((w) => w.company)).toEqual(["Library", "Northwind"]);
    expect(read.work[0]).toMatchObject({ current: true, end: "", bullets: ["Helped patrons", "Set up laptops"] });
    expect(read.work[1]).toMatchObject({ start: "2025-06", end: "2025-08", bullets: ["Built a thing"] });

    entries()[0].querySelector<HTMLButtonElement>("[aria-label='Remove']")!.click();
    read = readForm(form, emptyProfile());
    expect(read.work.map((w) => w.company)).toEqual(["Northwind"]);
  });

  it("keeps education and language entries, and drops blank ones", () => {
    const form = document.createElement("form");
    renderForm(form, {
      ...emptyProfile(),
      education: [{ school: "State University", degree: "BS", field: "CS", minor: "", gpa: "3.8", current: true, start: "2023-09", end: "2027-05" }],
      languages: [{ language: "Spanish", level: "Advanced" }],
    });
    form.querySelector<HTMLButtonElement>("[data-list='education'] .entry-add")!.click();
    const read = readForm(form, emptyProfile());
    expect(read.education).toEqual([{ school: "State University", degree: "BS", field: "CS", minor: "", gpa: "3.8", current: true, start: "2023-09", end: "2027-05" }]);
    expect(read.languages).toEqual([{ language: "Spanish", level: "Advanced" }]);
  });
});

describe("older saved profiles", () => {
  it("moves the phone details, splits the sponsorship answer and turns the start date into a date", () => {
    const old = {
      firstName: "Jordan",
      needsSponsorship: "Yes",
      startDate: "May 2027",
      questions: { heardFrom: "Referral", workedHereBefore: "No", over18: "Yes", phoneType: "Home", phoneCountry: "Canada" },
    };
    const p = withDefaults(old as never);
    expect(p).toMatchObject({ phoneType: "Home", phoneCountry: "Canada", sponsorshipNow: "Yes", sponsorshipFuture: "Yes", securityClearance: "None" });
    expect(p.questions).toEqual({ heardFrom: "Referral", workedHereBefore: "No", over18: "Yes", willingToRelocate: "", availableFrom: "2027-05-01", availableUntil: "" });
    expect("needsSponsorship" in p || "startDate" in p).toBe(false);
    expect(startOfMonth("05/2027")).toBe("2027-05-01");
    expect(startOfMonth("sometime soon")).toBe("");
  });

  it("moves the single school into the education list", () => {
    const p = withDefaults({ firstName: "Jordan", school: "State University", major: "CS", gpa: "3.8", graduationDate: "2027-05" } as never);
    expect(p.education).toEqual([{ school: "State University", degree: "", field: "CS", minor: "", gpa: "3.8", current: false, start: "", end: "2027-05" }]);
    expect(p.questions.heardFrom).toBe("Job board");
    expect("school" in p).toBe(false);
  });
});
