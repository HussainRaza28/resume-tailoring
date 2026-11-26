/**
 * Tailor Autofill in real Chromium, extension loaded, on a stand-in Workday
 * form (workday-mock.html) that behaves like a React form: it keeps its own
 * state, Next checks that state, some widgets take only real input, and
 * answers redraw parts of the form.
 *
 * What this proves: the extension's real-input path (chrome.debugger) works
 * end to end, survives elements being replaced, and gets every field into a
 * form's state where dispatched events and setting .value don't. What it
 * can't prove: that Workday itself behaves like the stand-in. That needs the
 * debug report from a real application.
 */
import { type BrowserContext, type Page, type Worker, chromium, expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILE as SAMPLE } from "../test/sampleProfile";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");
const MOCK = readFileSync(join(HERE, "workday-mock.html"), "utf8");
const URL = "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/Intern/apply/applyManually";

const PROFILE = {
  ...SAMPLE,
  preferredFirstName: "Jo",
  preferredLastName: "Sample",
  hasPreferredName: true,
  state: "Virginia",
  phoneType: "Mobile",
  phone: "5550100199",
  linkedin: "linkedin.com/in/jordan-sample",
  github: "github.com/jordan-sample",
  portfolio: "https://jordan.example",
  skills: ["Python", "Django", "C", "R", "SQL"],
  questions: { ...SAMPLE.questions, heardFrom: "LinkedIn" },
};

let context: BrowserContext;
let worker: Worker;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "tailor-live-")), {
    headless: true,
    channel: "chromium",
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await context.route("https://acme.wd1.myworkdayjobs.com/**", (route) => route.fulfill({ contentType: "text/html", body: MOCK }));
});

test.afterAll(async () => {
  await context.close();
});

async function store(settings: object): Promise<void> {
  await worker.evaluate(async ([profile, s]) => chrome.storage.local.set({ profile, settings: s, lastDebug: null }), [PROFILE, settings] as const);
}

async function open(query = ""): Promise<Page> {
  const page = await context.newPage();
  await page.goto(URL + query);
  await expect(page.locator("#tailor-autofill-button button")).toBeVisible();
  return page;
}

async function autofill(page: Page, timeout = 90_000): Promise<void> {
  await page.locator("#tailor-autofill-button button").click();
  await expect(page.locator("#tailor-autofill-summary .text")).toBeVisible({ timeout });
}

const next = (page: Page) => page.evaluate(() => (window as any).__mock.next() as string[]);
const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__mock.state)));

const REQUIRED_ON_PAGE = [
  "First Name", "Last Name", "State", "How Did You Hear About Us?", "Phone Device Type", "Phone Number",
  "Work Experience 1: Job Title", "Work Experience 1: Company", "Work Experience 1: From", "Work Experience 1: To",
  "Education 1: School or University", "Education 1: Degree", "Websites 1: URL",
];

test("setting .value on every field doesn't get anything past Next", async () => {
  await store({ realTyping: true, debug: false, debugValues: false });
  const page = await open();
  await page.evaluate(() => {
    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>("#app input[type='text'], #app input:not([type]), #app textarea"))) input.value = "2025";
  });
  expect(await next(page)).toEqual(REQUIRED_ON_PAGE);
  await page.close();
});

test("Autofill with dispatched events: text gets in, Workday's widgets don't", async () => {
  // Every widget that never answers waits out its list timeout, so this run is slow.
  test.setTimeout(400_000);
  await store({ realTyping: false, debug: false, debugValues: false });
  const page = await open();
  await autofill(page, 380_000);
  const errors = await next(page);
  // The widgets that take only real input stay empty.
  for (const field of ["State", "How Did You Hear About Us?", "Phone Device Type", "Work Experience 1: From", "Education 1: School or University", "Education 1: Degree"]) {
    expect(errors).toContain(field);
  }
  // Plain text took the dispatched input events.
  expect(errors).not.toContain("First Name");
  expect(errors).not.toContain("Work Experience 1: Job Title");
  await page.close();
});

test("Autofill with real typing fills the form so it passes Next", async () => {
  await store({ realTyping: true, debug: false, debugValues: false });
  const page = await open();
  await autofill(page);
  expect(await next(page)).toEqual([]);
  const s = await state(page);

  // Names, after "I have a preferred name" redrew the section; the phone number after Phone Device Type redrew its.
  expect([s.firstName, s.lastName, s.preferred, s.preferredFirst, s.preferredLast]).toEqual(["Jordan", "Sample", true, "Jo", "Sample"]);
  expect([s.countryRegion, s.phoneType, s.phoneNumber]).toEqual(["Virginia", "Home Cellular", "5550100199"]);
  expect(s.source).toEqual(["LinkedIn"]);

  // Two roles and two schools: Add was pressed once in each.
  expect(s.work.map((w: any) => [w.jobTitle, w.companyName, w.location, w.current])).toEqual([
    ["Software Engineering Intern", "Northwind Logistics", "Chicago, IL", false],
    ["Student Technology Assistant", "Springfield Public Library", "Springfield, IL", true],
  ]);
  expect(s.work.map((w: any) => [w.startDate, w.endDate])).toEqual([
    [{ month: 6, year: 2025 }, { month: 8, year: 2025 }],
    [{ month: 1, year: 2024 }, null],
  ]);
  for (const w of s.work) {
    const lines = w.roleDescription.split("\n");
    expect(lines.every((l: string) => l.startsWith("• ") && !l.startsWith("• •"))).toBe(true);
  }
  expect(s.education.map((e: any) => [e.school, e.degree, e.fieldOfStudy, e.gradeAverage, e.firstYearAttended, e.lastYearAttended])).toEqual([
    [["State University-Main Campus"], "Bachelors", ["Computer Science"], "3.8", { year: 2023 }, { year: 2027 }],
    [["Springfield Community College"], "Associates", ["Mathematics"], "3.9", { year: 2021 }, { year: 2023 }],
  ]);

  // Skills by name: Python's qualified name, never Django Admin, C#, C++ or Interactive SQL.
  expect(s.skills).toEqual(["Python (Programming Language)", "Django", "C (Programming Language)", "R Programming", "SQL"]);
  expect(s.websites).toEqual(["https://github.com/jordan-sample", "https://jordan.example"]);
  expect(s.linkedIn).toBe("https://linkedin.com/in/jordan-sample");

  // Only Add was pressed: never Delete, never Save and Continue.
  const pressed = await page.evaluate(() => (window as any).__mock.seen.filter((x: any) => x.what.startsWith("pressed")));
  expect(pressed).toEqual([]);
  await page.close();
});

test("a field the page refuses is reported as filled but not accepted, by label", async () => {
  await store({ realTyping: true, debug: false, debugValues: false });
  const page = await open("?refuse=phoneNumber");
  await autofill(page);
  await page.locator("#tailor-autofill-summary details summary").click();
  const details = page.locator("#tailor-autofill-summary details");
  await expect(details).toContainText("Filled but not accepted (1)");
  await expect(details).toContainText("Phone Number");
  await expect(details).not.toContainText("5550100199");
  await page.close();
});

test("Debug mode records every field without its value, and with it when asked", async () => {
  await store({ realTyping: true, debug: true, debugValues: false });
  const page = await open();
  await autofill(page);
  const report = await worker.evaluate(async () => (await chrome.storage.local.get(["lastDebug"])).lastDebug);
  expect(report.input.mode).toBe("trusted");
  const byLabel = (label: string) => report.fields.find((f: any) => f.label === label);
  expect(byLabel("Phone Number")).toMatchObject({ kind: "text", method: "trusted", outcome: "filled", matches: true, set: { length: 10, empty: false } });
  expect(byLabel("Phone Device Type")).toMatchObject({ kind: "dropdown", matches: false });
  expect(byLabel("Work Experience 1: From")).toMatchObject({ kind: "segmented date", outcome: "accepted", matches: true });
  expect(byLabel("Education 1: School or University")).toMatchObject({ kind: "multi-select", outcome: "accepted" });
  // Workday-style redraws show up: the phone number's element was replaced while the form was filled.
  expect(report.fields.some((f: any) => f.replaced)).toBe(true);
  // No values anywhere.
  const json = JSON.stringify(report);
  for (const value of ["Jordan", "5550100199", "Northwind", "Virginia", "Computer Science"]) expect(json).not.toContain(value);
  await page.close();

  await store({ realTyping: true, debug: true, debugValues: true });
  const again = await open();
  await autofill(again);
  const raw = await worker.evaluate(async () => (await chrome.storage.local.get(["lastDebug"])).lastDebug);
  expect(raw.fields.find((f: any) => f.label === "First Name").set.value).toBe("Jordan");
  await again.close();
});
