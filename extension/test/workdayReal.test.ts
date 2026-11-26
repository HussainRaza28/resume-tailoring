/**
 * Workday's real markup: the three saved application pages in test-fixtures/
 * (sanitized copies), filled from a profile.
 *
 * jsdom doesn't run Workday's scripts, so `installWorkday` stands in for them,
 * built from what the saved pages show:
 *
 * - A date segment (`dateSection*-input`) is committed, meaning its display
 *   shows the digits and the input gets aria-valuenow, only when the digits
 *   arrive as key presses and the field is then blurred. A value set without
 *   keys stays on screen but isn't committed, and the field says "The field
 *   From is required and must have a value", as on the real page.
 * - A search list (`selectinput`) opens its options on Enter; clicking one
 *   adds a chip in the same markup as the saved page with School and Field of
 *   Study chosen (selectedItemList > menuItem > selectedItem > promptOption).
 * - A dropdown button (aria-haspopup="listbox") opens a list of role="option"
 *   elements; the chosen text replaces "Select One".
 * - Add clones an entry a moment after the click, with fresh ids.
 * - `validate` is pressing Next: required fields, committed dates, chosen
 *   items, and full URLs, each failure an error under its field.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fillPage } from "../src/fill/engine";
import { bulletLines, withScheme } from "../src/fill/format";
import { workday } from "../src/fill/sites";
import {
  aliasesFor,
  buttonValue,
  chipsIn,
  dateSegments,
  fieldError,
  rankOption,
  segmentTaken,
  setWorkdayDate,
} from "../src/fill/workdayWidgets";
import type { Profile } from "../src/profile";
import { reportGroups } from "../src/summary";
import { installWorkday, uninstallWorkday, validate } from "./workdayEmulator";
import { PROFILE as SAMPLE } from "./sampleProfile";

const PROFILE: Profile = {
  ...SAMPLE,
  state: "Virginia",
  phoneType: "Mobile",
  // Links as people type them: no scheme.
  linkedin: "linkedin.com/in/jordan-sample",
  github: "github.com/jordan-sample",
  portfolio: "https://jordan.example",
  questions: { ...SAMPLE.questions, heardFrom: "LinkedIn" },
};

// ---------------------------------------------------------------------------

const RESUME = new File(["%PDF-1.4"], "resume.pdf", { type: "application/pdf" });

function load(name: string): void {
  const html = readFileSync(join(process.cwd(), "test-fixtures", name), "utf8");
  document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
}

/** The page with nothing chosen yet: the saved page with School, Degree and years chosen, cleared. */
function clearChosen(): void {
  document.querySelectorAll("[data-automation-id='selectedItemList']").forEach((x) => x.parentElement!.remove());
  document.querySelectorAll<HTMLElement>("[data-automation-id='promptAriaInstruction']").forEach((x) => (x.textContent = "0 items selected"));
  document.querySelectorAll("#education-664--degree").forEach((b) => (b.textContent = "Select One"));
  document.querySelectorAll<HTMLInputElement>("[data-automation-id^='dateSection'][data-automation-id$='-input']").forEach((x) => {
    x.value = "";
    x.setAttribute("value", "");
    x.removeAttribute("aria-valuenow");
  });
  document.querySelectorAll("[data-automation-id='dateSectionYear-display']").forEach((x) => (x.textContent = "YYYY"));
}

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const all = <T extends HTMLElement = HTMLElement>(s: string) => Array.from(document.querySelectorAll<T>(s));
const inField = (name: string) => all(`[data-automation-id='formField-${name}']`);

beforeEach(() => {
  uninstallWorkday();
  document.body.innerHTML = "";
});

describe("the saved pages are Workday's markup", () => {
  it("the page with choices made shows what Workday counts as taken", () => {
    load("workday_my_experience_dropdown_open.html");
    expect(chipsIn($("[data-automation-id='formField-school']"))).toEqual(["Springfield State University-Main Campus"]);
    expect(chipsIn($("[data-automation-id='formField-fieldOfStudy']"))).toEqual(["Computer Science"]);
    expect(buttonValue($("#education-664--degree"))).toBe("Bachelors");
    expect(segmentTaken($<HTMLInputElement>("#education-664--firstYearAttended-dateSectionYear-input"), "2023")).toBe(true);
    // The empty page: "Select One", no chips, years not taken.
    load("workday_my_experience.html");
    expect(buttonValue($("#education-664--degree"))).toBe("");
    expect(chipsIn($("[data-automation-id='formField-school']"))).toEqual([]);
    expect(segmentTaken($<HTMLInputElement>("#education-664--firstYearAttended-dateSectionYear-input"), "2023")).toBe(false);
  });

  it("My Information has a chosen chip with role=option before any list opens", () => {
    load("workday_my_information.html");
    // The trap behind State and Phone Device Type staying empty: this chip counted as the open list.
    expect(all("[role='option']").map((o) => o.getAttribute("data-automation-id"))).toEqual(["selectedItem"]);
    expect($("#address--countryRegion").textContent!.trim()).toBe("Select One");
  });
});

describe("Workday My Experience, filled", () => {
  it("dates taken, school and field of study chosen, entries added, websites full, descriptions bulleted, no errors", async () => {
    load("workday_my_experience.html");
    installWorkday();
    const report = await fillPage(document, PROFILE, RESUME, workday, { pauseMs: 0 });

    // One entry per role, school and link: Add was pressed for the second of each.
    expect(all("[data-automation-id='formField-jobTitle'] input").map((x) => (x as HTMLInputElement).value)).toEqual([
      "Software Engineering Intern",
      "Student Technology Assistant",
    ]);
    expect(inField("school").map(chipsIn)).toEqual([["State University-Main Campus"], ["Springfield Community College"]]);
    expect(inField("fieldOfStudy").map(chipsIn)).toEqual([["Computer Science"], ["Mathematics"]]);
    expect(inField("degree").map((f) => buttonValue(f.querySelector("button")!))).toEqual(["Bachelors", "Associates"]);

    // Dates: committed by Workday, month and year for work, the year alone for school.
    const date = (field: HTMLElement) => {
      const { month, year } = dateSegments(field);
      return [month?.getAttribute("aria-valuenow"), year?.getAttribute("aria-valuenow")].filter(Boolean).join("/");
    };
    expect(inField("startDate").map(date)).toEqual(["6/2025", "1/2024"]);
    expect(inField("endDate").map(date)).toEqual(["8/2025", ""]);
    expect(inField("firstYearAttended").map(date)).toEqual(["2023", "2021"]);
    expect(inField("lastYearAttended").map(date)).toEqual(["2027", "2023"]);

    // Websites: one entry per link, each a full URL; LinkedIn too.
    expect(all<HTMLInputElement>("[data-automation-id='formField-url'] input").map((x) => x.value)).toEqual([
      "https://github.com/jordan-sample",
      "https://jordan.example",
    ]);
    expect($<HTMLInputElement>("#socialNetworkAccounts--linkedInAccount").value).toBe("https://linkedin.com/in/jordan-sample");

    // Role descriptions: every line starts with a bullet, once.
    const description = $<HTMLTextAreaElement>("[data-automation-id='formField-roleDescription'] textarea").value;
    expect(description.split("\n").every((l) => l.startsWith("• ") && !l.startsWith("• •"))).toBe(true);

    expect(chipsIn($("[data-automation-id='formField-skills']"))).toEqual(["Python", "PostgreSQL", "Docker"]);
    expect(validate()).toEqual([]);
    expect(report.notAccepted).toEqual([]);
  });

  it("only ever presses Add", async () => {
    load("workday_my_experience.html");
    installWorkday();
    const pressed: string[] = [];
    document.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest?.("button");
      if (b && !b.closest("[data-test-popup]") && b.getAttribute("aria-haspopup") !== "listbox") pressed.push(b.textContent!.trim());
    }, true);
    await fillPage(document, PROFILE, RESUME, workday, { pauseMs: 0 });
    expect(new Set(pressed)).toEqual(new Set(["Add Another"]));
  });

  it("a school with no match is reported and its typed text cleared", async () => {
    load("workday_my_experience.html");
    installWorkday();
    const profile = { ...PROFILE, education: [{ ...PROFILE.education[0], school: "Nowhere Institute" }] };
    const report = await fillPage(document, profile, RESUME, workday, { pauseMs: 0 });
    const school = $<HTMLInputElement>("#education-664--school");
    expect(school.value).toBe("");
    expect(chipsIn(school.closest("[data-automation-id='formField-school']"))).toEqual([]);
    expect(report.left).toContain(school);
  });

  it("a field Workday shows but refuses is retried, then reported as filled but not accepted, by label only", async () => {
    load("workday_my_experience.html");
    installWorkday({ refuse: ["startDate"] });
    const report = await fillPage(document, PROFILE, RESUME, workday, { pauseMs: 0 });
    const groups = reportGroups(report);
    const notAccepted = groups.find((g) => g.title === "Filled but not accepted")!;
    expect(notAccepted.labels).toEqual(["Work Experience 1: From", "Work Experience 2: From"]);
    // Labels only: no dates or other values in the report.
    expect(JSON.stringify(groups)).not.toMatch(/2025|2024|Northwind|Python service/);
    // Not counted as filled, and outlined for the person like any field left for them.
    expect(report.notAccepted).toHaveLength(2);
    for (const el of report.notAccepted!) {
      expect(report.filled).not.toContain(el);
      expect(report.left).toContain(el);
    }
  });

  it("the page with choices already made is left as it is", async () => {
    load("workday_my_experience_dropdown_open.html");
    installWorkday();
    const profile = { ...PROFILE, education: [{ ...PROFILE.education[0], school: "Springfield State University", start: "2023-09", end: "2027-05" }] };
    await fillPage(document, profile, RESUME, workday, { pauseMs: 0 });
    expect(inField("school").map(chipsIn)).toEqual([["Springfield State University-Main Campus"]]);
    expect(inField("fieldOfStudy").map(chipsIn)).toEqual([["Computer Science"]]);
    expect(buttonValue($("#education-664--degree"))).toBe("Bachelors");
  });

  it("the page cleared of its choices is filled the same way", async () => {
    load("workday_my_experience_dropdown_open.html");
    clearChosen();
    installWorkday();
    await fillPage(document, PROFILE, RESUME, workday, { pauseMs: 0 });
    expect(inField("school").map(chipsIn)).toEqual([["State University-Main Campus"], ["Springfield Community College"]]);
    expect(validate()).toEqual([]);
  });
});

describe("Workday My Information, filled", () => {
  it("State and Phone Device Type are picked from their lists; nothing is left with an error", async () => {
    load("workday_my_information.html");
    installWorkday();
    const report = await fillPage(document, PROFILE, RESUME, workday, { pauseMs: 0 });
    expect($("#address--countryRegion").textContent).toBe("Virginia");
    // No "Mobile" in this tenant's list: the cell phone option is.
    expect($("#phoneNumber--phoneType").textContent).toBe("Home Cellular");
    expect(chipsIn($("[data-automation-id='formField-source']"))).toEqual(["LinkedIn"]);
    expect($<HTMLInputElement>("#name--legalName--firstName").value).toBe("Jordan");
    expect(validate()).toEqual([]);
    expect(report.notAccepted).toEqual([]);
  });

  it("a dropdown Workday refuses is reported as filled but not accepted", async () => {
    load("workday_my_information.html");
    installWorkday({ refuse: ["phoneType"] });
    const report = await fillPage(document, PROFILE, RESUME, workday, { pauseMs: 0 });
    expect(reportGroups(report).find((g) => g.title === "Filled but not accepted")?.labels).toEqual(["Phone Device Type"]);
  });
});

describe("normalizing values", () => {
  it("URLs get https:// when they have no scheme", () => {
    expect(withScheme("linkedin.com/in/jordan")).toBe("https://linkedin.com/in/jordan");
    expect(withScheme("www.example.com")).toBe("https://www.example.com");
    expect(withScheme("//example.com/x")).toBe("https://example.com/x");
    expect(withScheme("https://github.com/x")).toBe("https://github.com/x");
    expect(withScheme("http://old.example")).toBe("http://old.example");
    expect(withScheme("localhost:3000/demo")).toBe("https://localhost:3000/demo");
    expect(withScheme("  ")).toBe("");
  });

  it("each line gets one bullet, never two", () => {
    expect(bulletLines(["Built a thing", "• Already marked", "- Dashed", "1. Numbered", "  "])).toBe(
      "• Built a thing\n• Already marked\n- Dashed\n1. Numbered",
    );
    expect(bulletLines(bulletLines(["Once"]))).toBe("• Once");
    expect(bulletLines("Line one\nLine two")).toBe("• Line one\n• Line two");
  });

  it("options are chosen exact, then starts with, then contains, shortest first", () => {
    const fields = ["Computer Science and Engineering", "Computer Science", "Applied Computer Science"];
    expect(fields[rankOption(fields, "Computer Science")]).toBe("Computer Science");
    const schools = ["University of Springfield's College at Shelby", "University of Springfield-Main Campus"];
    expect(schools[rankOption(schools, "University of Springfield")]).toBe("University of Springfield-Main Campus");
    expect(rankOption(["Vermont", "West Virginia", "Virginia"], "Virginia")).toBe(2);
    const phones = ["Landline", "Home Cellular", "Work"];
    expect(phones[rankOption(phones, "Mobile", aliasesFor("Mobile"))]).toBe("Home Cellular");
    expect(rankOption(["Biology"], "Computer Science")).toBe(-1);
  });
});

describe("Workday dates on the saved page", () => {
  it("month and year, and the year alone, are typed and committed", async () => {
    load("workday_my_experience.html");
    installWorkday();
    const from = $("#workExperience-655--startDate");
    expect(await setWorkdayDate(from, "6", "2025")).toBe("accepted");
    expect(from.querySelector("[data-automation-id='dateSectionMonth-display']")!.textContent).toBe("06");
    expect(from.querySelector("[data-automation-id='dateSectionYear-display']")!.textContent).toBe("2025");
    const yearOnly = $("#education-664--lastYearAttended");
    expect(await setWorkdayDate(yearOnly, "5", "2027")).toBe("accepted");
    expect(dateSegments(yearOnly).year!.getAttribute("aria-valuenow")).toBe("2027");
    expect(fieldError(yearOnly.closest("[data-automation-id^='formField-']") as HTMLElement)).toBe("");
  });
});
