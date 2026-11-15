/**
 * Import from Tailor, with the file the Tailor app really exports for its
 * sample resume (tests/test_autofill.py keeps the two equal).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changes, mergeImport, parseTailorExport } from "../src/importTailor";
import { DECLINE, emptyProfile } from "../src/profile";
import { readForm, renderForm } from "../src/profileForm";

const EXPORT = readFileSync(join(process.cwd(), "test", "fixtures", "tailor-autofill-profile.json"), "utf8");

describe("Import from Tailor", () => {
  it("reads the app's export", () => {
    const data = parseTailorExport(EXPORT);
    expect(data.profile.firstName).toBe("Jordan");
    expect(data.profile.work).toHaveLength(2);
    expect(data.facts).toEqual(["TrailMap is also used by 12 trail guides"]);
  });

  it("refuses anything else, with a message that says what to do", () => {
    expect(() => parseTailorExport("not json")).toThrow(/Export it again/);
    expect(() => parseTailorExport('{"name": "x"}')).toThrow(/isn't a Tailor Autofill profile/);
    expect(() => parseTailorExport('{"format": "tailor-autofill-profile", "version": 2, "profile": {}}')).toThrow(/newer Tailor/);
  });

  it("fills an empty profile, and keeps what a resume doesn't hold", () => {
    const current = { ...emptyProfile(), street: "100 Main St", city: "Springfield", workAuthorized: "Yes", languages: [{ language: "Spanish", level: "Fluent" }] };
    current.demographics.gender = "Female";
    const next = mergeImport(current, parseTailorExport(EXPORT));
    expect(next).toMatchObject({ firstName: "Jordan", lastName: "Sample", email: "jordan.sample@example.com", phone: "555-010-0199" });
    expect(next.linkedin).toBe("https://www.linkedin.com/in/jordan-sample");
    expect(next.work.map((w) => [w.company, w.start, w.end])).toEqual([
      ["Northwind Logistics", "2025-06", "2025-08"],
      ["Springfield Public Library", "2023-09", "2025-05"],
    ]);
    expect(next.work[0].bullets).toHaveLength(4);
    expect(next.education[0]).toMatchObject({ school: "State University", degree: "Bachelor of Science", field: "Computer Science", minor: "Statistics", end: "2027-05" });
    expect(next.skills).toContain("PostgreSQL");
    expect(next.facts).toEqual(["TrailMap is also used by 12 trail guides"]);
    // Untouched: address, authorization, languages, answers, self-identification.
    expect(next).toMatchObject({ street: "100 Main St", city: "Springfield", workAuthorized: "Yes" });
    expect(next.languages).toEqual([{ language: "Spanish", level: "Fluent" }]);
    expect(next.questions.heardFrom).toBe("Job board");
    expect(next.demographics).toMatchObject({ gender: "Female", race: DECLINE });
    // The profile it started from isn't changed until the person applies.
    expect(current.firstName).toBe("");
  });

  it("previews each change, and nothing when the profile already matches", () => {
    const before = { ...emptyProfile(), email: "old@example.com" };
    const after = mergeImport(before, parseTailorExport(EXPORT));
    const found = changes(before, after);
    expect(found.find((c) => c.label === "Email")).toEqual({ label: "Email", was: "old@example.com", now: "jordan.sample@example.com" });
    expect(found.find((c) => c.label === "Role 1")?.now).toBe(
      "Software Engineering Intern, Routing Team · Northwind Logistics · Jun 2025 to Aug 2025 (4 bullets)",
    );
    expect(found.map((c) => c.label)).toEqual(expect.arrayContaining(["First name", "Role 2", "School 1", "Skills", "Facts"]));
    expect(changes(after, mergeImport(after, parseTailorExport(EXPORT)))).toEqual([]);
  });

  it("stays editable: the imported profile renders in the form and reads back the same", () => {
    const imported = mergeImport(emptyProfile(), parseTailorExport(EXPORT));
    const form = document.createElement("form");
    renderForm(form, imported);
    expect(form.querySelectorAll(".entry[data-kind='work']")).toHaveLength(2);
    expect(readForm(form, imported)).toEqual(imported);
  });
});
