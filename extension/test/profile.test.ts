import { describe, expect, it } from "vitest";
import {
  DECLINE,
  MAX_RESUME_BYTES,
  type Store,
  emptyProfile,
  graduationParts,
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
    expect(graduationParts("2027-05")).toEqual({ year: "2027", month: "05", monthName: "May" });
    expect(graduationParts("")).toEqual({ year: "", month: "", monthName: "" });
  });
});

describe("profile form", () => {
  it("shows the profile, and reads back what was typed", () => {
    const form = document.createElement("form");
    renderForm(form, { ...emptyProfile(), firstName: "Jordan", graduationDate: "2027-05" });
    const field = (key: string) => form.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-key="${key}"]`)!;
    expect(field("firstName").value).toBe("Jordan");
    expect(field("graduationDate").getAttribute("type")).toBe("month");
    expect(field("gender").value).toBe(DECLINE);

    field("lastName").value = "  Sample ";
    field("needsSponsorship").value = "No";
    field("race").value = "Asian";
    const read = readForm(form, emptyProfile());
    expect(read).toMatchObject({ firstName: "Jordan", lastName: "Sample", needsSponsorship: "No", graduationDate: "2027-05" });
    expect(read.demographics).toMatchObject({ race: "Asian", gender: DECLINE });
  });

  it("has a field for everything the autofill uses", () => {
    const form = document.createElement("form");
    renderForm(form, emptyProfile());
    const keys = Array.from(form.querySelectorAll<HTMLElement>("[data-key]")).map((el) => el.dataset.key);
    const expected = [...Object.keys(emptyProfile()).filter((k) => k !== "demographics"), ...Object.keys(emptyProfile().demographics)];
    expect(keys.sort()).toEqual(expected.sort());
  });
});
