/**
 * SAP SuccessFactors, on a saved copy of a real application page: Ascend
 * Learning's (ascendlearning.jobs.hr.cloud.sap), in test-fixtures/. The saved
 * page comes prefilled, so every field is cleared first; only its structure
 * matters.
 *
 * jsdom doesn't run the page's scripts, so the harness does what the browser
 * and SuccessFactors would:
 * - attaches the shadow roots Chrome saved as <template shadowrootmode>;
 * - stands in for each field's onchange="juic.fire(...)" with a recorder, to
 *   check that SuccessFactors hears about every value (the page's inline
 *   handlers are taken off: jsdom would run them where juic doesn't exist);
 * - acts as the UI5 date picker: it takes a date only when its inner input
 *   fires change, and marks a date it can't read as an error;
 * - adds a row, a moment after "Add new row" is pressed, by copying the
 *   section's first row with new ids, as SuccessFactors draws it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fillPage } from "../src/fill/engine";
import { siteFor, successFactors } from "../src/fill/sites";
import { addRowButton, rowsIn, sectionKind } from "../src/fill/successfactors";
import type { Profile } from "../src/profile";
import { PROFILE as BASE } from "./sampleProfile";

const FIXTURE = readFileSync(join(process.cwd(), "test-fixtures", "ascend_apply_page.html"), "utf8");

/** The person: two roles (the first written as "May 2025" to "August 2025", the second current) and two schools. */
const PROFILE: Profile = {
  ...BASE,
  work: [
    { ...BASE.work[0], title: "Software Engineering Intern, Routing Team", company: "Northwind Logistics", start: "May 2025", end: "August 2025" },
    { ...BASE.work[1] },
  ],
  education: [
    { ...BASE.education[0], start: "2023-08", end: "2028-02" },
    { ...BASE.education[1], start: "2021-09", end: "2023-05" },
  ],
};

let changes: string[] = [];
let committed = new Map<HTMLElement, string>();

/** Chrome turns <template shadowrootmode> into shadow roots while it parses; jsdom doesn't, so do it here. */
function attachShadowRoots(root: ParentNode): void {
  for (const template of Array.from(root.querySelectorAll<HTMLTemplateElement>("template[shadowrootmode]"))) {
    const host = template.parentElement;
    if (!host || host.shadowRoot) continue;
    const shadow = host.attachShadow({ mode: template.getAttribute("shadowrootmode") as ShadowRootMode });
    shadow.append(template.content);
    template.remove();
    attachShadowRoots(shadow);
  }
}

/** The input inside a date picker (it sits two shadow roots down). */
function inner(host: Element): HTMLInputElement {
  const search = (root: ParentNode): HTMLInputElement | null =>
    root.querySelector("input") ?? Array.from(root.querySelectorAll("*")).reduce<HTMLInputElement | null>((found, el) => found ?? (el.shadowRoot ? search(el.shadowRoot) : null), null);
  return search(host.shadowRoot!)!;
}

const pickers = () => Array.from(document.querySelectorAll<HTMLElement>("[ui5-date-picker]"));

/** What the UI5 date picker does when its input changes: take a MM/dd/yyyy date, or mark an error. */
function wirePicker(host: HTMLElement): void {
  const input = inner(host);
  input.addEventListener("change", () => {
    const ok = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/.test(input.value);
    host.setAttribute("value-state", ok ? "None" : "Error");
    if (ok) committed.set(host, input.value);
  });
}

/** SuccessFactors' side: onchange handlers, date pickers, and Add new row. */
function wirePage(): void {
  (window as unknown as { juic: { fire: (id: string, action: string) => void } }).juic = {
    fire: (id, action) => {
      if (action === "_handleChange") changes.push(id);
    },
  };
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>("input[data-juic-id]"))) wireInput(input);
  pickers().forEach(wirePicker);
  for (const button of Array.from(document.querySelectorAll<HTMLElement>("[id$='_addRowBtn']"))) {
    button.addEventListener("click", () => setTimeout(() => addRow(button), 40));
  }
}

function wireInput(input: HTMLInputElement): void {
  const id = input.dataset.juicId;
  input.addEventListener("change", () => {
    if (id) (window as unknown as { juic: { fire: (id: string, action: string) => void } }).juic.fire(id, "_handleChange");
    committed.set(input, input.value);
  });
}

let rowCount = 0;
/** A new row: the section's first row copied with fresh ids and nothing in it. */
function addRow(button: HTMLElement): void {
  const section = button.closest("[id$=':section']")!;
  const rows = rowsIn(section);
  const first = rows[0];
  const copy = first.cloneNode(true) as HTMLElement;
  const suffix = `r${++rowCount}`;
  for (const el of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>("[id]"))]) el.id = `${el.id}${suffix}`;
  for (const label of Array.from(copy.querySelectorAll("label[for]"))) label.setAttribute("for", `${label.getAttribute("for")}${suffix}`);
  for (const input of Array.from(copy.querySelectorAll<HTMLInputElement>("input"))) {
    input.value = "";
    if (input.dataset.juicId) input.dataset.juicId += suffix;
    wireInput(input);
  }
  // A copied element loses its shadow root; draw the date picker's input again.
  for (const host of Array.from(copy.querySelectorAll<HTMLElement>("[ui5-date-picker]"))) {
    host.setAttribute("value", "");
    host.attachShadow({ mode: "open" }).innerHTML = '<input id="inner" class="ui5-input-inner" placeholder="MM/DD/YYYY">';
    wirePicker(host);
  }
  rows[rows.length - 1].after(copy);
}

/** Empty every field the saved page came with. */
function clearPrefilled(): void {
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>("input:not([type='hidden']):not([type='submit'])"))) {
    input.value = "";
    input.removeAttribute("value");
    input.removeAttribute("title");
  }
  for (const host of pickers()) {
    host.setAttribute("value", "");
    inner(host).value = "";
  }
  for (const date of Array.from(document.querySelectorAll("[ui5-date]"))) date.setAttribute("value", "");
}

/** Keep which SuccessFactors handler a field's onchange calls, then take the page's inline handlers off. */
function takeOffHandlers(): void {
  for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (!attr.name.startsWith("on")) continue;
      if (attr.name === "onchange") {
        const id = attr.value.match(/juic\.fire\("([^"]+)"/)?.[1];
        if (id) el.dataset.juicId = id;
      }
      el.removeAttribute(attr.name);
    }
  }
}

function load(): void {
    document.body.innerHTML = FIXTURE;
  document.querySelectorAll("script").forEach((s) => s.remove());
  takeOffHandlers();
  attachShadowRoots(document.body);
  clearPrefilled();
  changes = [];
  committed = new Map();
  rowCount = 0;
  wirePage();
}

const section = (kind: "work" | "education") => Array.from(document.querySelectorAll("[id$=':section']")).find((s) => sectionKind(s) === kind)!;
const inRow = (row: Element, label: string) => {
  const l = Array.from(row.querySelectorAll("label")).find((x) => x.textContent!.replace(/[*\s]+/g, " ").trim() === label)!;
  const field = l.closest(".RCMFormField")!;
  return (field.querySelector("input[data-testid='sfTextField']") ?? field.querySelector("[ui5-date-picker]")) as HTMLElement;
};
const text = (row: Element, label: string) => (inRow(row, label) as HTMLInputElement).value;
const date = (row: Element, label: string) => inner(inRow(row, label)).value;

beforeEach(() => load());

describe("SuccessFactors (Ascend Learning's application page)", () => {
  it("is recognised", () => {
    expect(siteFor("https://ascendlearning.jobs.hr.cloud.sap/job/Leawood-Data-Architect/1152/apply")?.name).toBe("SuccessFactors");
    expect(siteFor("https://career4.successfactors.com/career?company=x")?.name).toBe("SuccessFactors");
  });

  it("starts with one row each in Work Experience and Education, cleared", () => {
    expect(rowsIn(section("work"))).toHaveLength(1);
    expect(rowsIn(section("education"))).toHaveLength(1);
    expect(addRowButton(section("work"))).not.toBeNull();
    expect(pickers().every((p) => inner(p).value === "")).toBe(true);
  });

  it("adds a row per role and school, and fills company, title and dates in each, read back", async () => {
    const report = await fillPage(document, PROFILE, null, successFactors, { pauseMs: 5 });
    const work = rowsIn(section("work"));
    const edu = rowsIn(section("education"));
    expect(work).toHaveLength(2);
    expect(edu).toHaveLength(2);

    // Row 1: "May 2025" to "August 2025" become the 1st and the 31st. The full title, not cut off.
    expect(text(work[0], "Job Title")).toBe("Software Engineering Intern, Routing Team");
    expect(text(work[0], "Company / Organization")).toBe("Northwind Logistics");
    expect(date(work[0], "Start Date")).toBe("05/01/2025");
    expect(date(work[0], "End Date")).toBe("08/31/2025");
    // Row 2: the current role. Its end date stays blank.
    expect(text(work[1], "Job Title")).toBe("Student Technology Assistant");
    expect(text(work[1], "Company / Organization")).toBe("Springfield Public Library");
    expect(date(work[1], "Start Date")).toBe("01/01/2024");
    expect(date(work[1], "End Date")).toBe("");

    // Education: February 2028 ends on the 29th, a leap year.
    expect(text(edu[0], "School")).toBe("State University");
    expect(text(edu[0], "Level of Education / Degree")).toBe("Bachelor's Degree");
    expect(date(edu[0], "From Date")).toBe("08/01/2023");
    expect(date(edu[0], "End Date")).toBe("02/29/2028");
    expect(text(edu[1], "School")).toBe("Springfield Community College");
    expect(date(edu[1], "From Date")).toBe("09/01/2021");
    expect(date(edu[1], "End Date")).toBe("05/31/2023");

    // SuccessFactors heard every value: its change handler ran for the company field, and
    // each date picker took its date from its own input's change event.
    expect(changes).toContain("122:");
    for (const row of work) {
      const company = inRow(row, "Company / Organization");
      expect(committed.get(company)).toBe((company as HTMLInputElement).value);
    }
    expect(committed.get(inRow(work[0], "Start Date"))).toBe("05/01/2025");
    expect(committed.get(inRow(edu[0], "End Date"))).toBe("02/29/2028");
    expect(pickers().some((p) => p.getAttribute("value-state") === "Error")).toBe(false);

    // The report: nothing failed the read-back; the current role's end date was skipped, by label.
    expect(report.failed).toEqual([]);
    expect(report.skipped!.map((el) => report.labels!.get(el))).toContain("End Date");
    expect(report.labels!.get(inRow(work[0], "Company / Organization"))).toBe("Company / Organization");
  });

  it("fills the rest by label and the site's own names: name, phone, address, start date", async () => {
    await fillPage(document, PROFILE, null, successFactors, { pauseMs: 0 });
    const byName = (name: string) => document.querySelector<HTMLInputElement>(`input[name='${name}']`)!.value;
    expect([byName("firstName"), byName("lastName"), byName("cellPhone"), byName("address"), byName("city"), byName("zip")]).toEqual([
      "Jordan",
      "Sample",
      "555-010-0199",
      "100 Main St",
      "Springfield",
      "62701",
    ]);
    // No preferred name in the profile: skipped, not invented.
    expect(byName("knownAs")).toBe("");
    // Only for people who worked there before: left alone.
    expect(byName("custLegalNameAtEmployment")).toBe("");
    const start = pickers().find((p) => p.getAttribute("accessible-name") === "What date are you available to start?")!;
    expect(inner(start).value).toBe("05/17/2027");
  });

  it("sets a value again when the page drops it, and reports a field that never keeps it", async () => {
    const work = rowsIn(section("work"))[0];
    // The title field loses its value once, as a controlled input re-rendering would.
    const title = inRow(work, "Job Title") as HTMLInputElement;
    let wiped = false;
    title.addEventListener("input", () => {
      if (wiped) return;
      wiped = true;
      setTimeout(() => (title.value = ""), 5);
    });
    // The company field cuts everything to 8 characters, every time.
    const company = inRow(work, "Company / Organization") as HTMLInputElement;
    company.addEventListener("input", () => setTimeout(() => (company.value = company.value.slice(0, 8)), 5));

    const report = await fillPage(document, { ...PROFILE, work: [PROFILE.work[0]], education: [] }, null, successFactors, { pauseMs: 0 });
    expect(title.value).toBe("Software Engineering Intern, Routing Team");
    expect(report.filled).toContain(title);
    expect(company.value).toBe("Northwin");
    expect(report.failed).toEqual([company]);
    expect(report.labels!.get(company)).toBe("Company / Organization");
  });

  it("fills only the application form, not the site's job search above it", async () => {
    const report = await fillPage(document, PROFILE, null, successFactors, { pauseMs: 0 });
    const reported = [...report.filled, ...report.left, ...report.skipped!];
    expect(reported.some((el) => el.closest("form[name='keywordsearch']"))).toBe(false);
    expect(reported.every((el) => el.closest("form#careerform"))).toBe(true);
  });

  it("presses only Add: never a row's Remove, never Submit", async () => {
    const pressed: string[] = [];
    document.addEventListener("click", (e) => pressed.push((e.target as HTMLElement).id || (e.target as HTMLElement).textContent!.trim()), true);
    await fillPage(document, PROFILE, null, successFactors, { pauseMs: 0 });
    const presses = pressed.filter((p) => /addRowBtn|remove|submit|apply/i.test(p));
    expect(presses.every((p) => p.endsWith("_addRowBtn"))).toBe(true);
    expect(presses).toHaveLength(2);
  });
});
