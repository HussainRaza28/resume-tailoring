import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const posting = readFileSync(new URL("../../tests/fixtures/sample_posting.txt", import.meta.url), "utf8");
const mod = process.platform === "darwin" ? "Meta" : "Control";

test("paste, diagnose, rewrite, re-score and export", async ({ page }) => {
  await page.goto("/?speed=10");
  await expect(page.getByRole("heading", { name: "Paste a job posting" })).toBeVisible();
  await page.getByLabel("Job posting").fill(posting);
  await page.getByLabel("Job posting").press(`${mod}+Enter`);

  // the diagnosis then the rewrites stream in
  await expect(page.getByRole("tab", { name: /Rewrite/ })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  await expect(page.locator(".bullet").first()).toBeVisible();

  // Diagnose: a base score, three red flags, skipped sections and backed-up keywords
  await page.getByRole("tab", { name: /Diagnose/ }).click();
  await expect(page.getByRole("meter", { name: "Base resume score" })).toBeVisible();
  await expect(page.getByText("ATS 62 · Hiring manager 54")).toBeVisible();
  await expect(page.locator(".flag")).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "Sections that get skipped" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Missing keywords you can back up" })).toBeVisible();
  await page.getByRole("button", { name: "See the rewrites that fix these" }).click();
  await expect(page.getByRole("tab", { name: /Rewrite/ })).toHaveAttribute("aria-selected", "true");

  // a blocked rewrite cannot be accepted and says why
  const blocked = page.locator(".bullet", { hasText: "Reviewed 40+ pull requests" });
  await expect(blocked.getByText('Number "40+" is not in the cited sources.')).toBeVisible();
  await expect(blocked.getByRole("button", { name: /Accept rewrite/ })).toBeDisabled();

  // keyboard: right arrow accepts the focused bullet
  await page.locator("body").click({ position: { x: 5, y: 500 } });
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".bullet").first().getByText("Accepted")).toBeVisible();

  // answering the question unlocks the blocked bullet through the facts bank
  await blocked.getByLabel(/How many pull requests/).fill("12");
  await blocked.getByRole("button", { name: "Save to facts" }).click();
  await expect(page.getByText("Reviewed 12 pull requests and shipped backend fixes")).toBeVisible();
  await expect(page.locator(".bullet", { hasText: "Reviewed 12 pull requests" }).getByRole("button", { name: /Accept rewrite/ })).toBeEnabled();

  // edit a bullet
  const lib = page.locator(".bullet", { hasText: "library patrons" });
  await lib.getByRole("button", { name: "Edit (E)" }).click();
  await lib.getByLabel("Edit the rewrite").fill("Fixed computer and printer problems for library patrons at the help desk");
  await lib.getByRole("button", { name: "Check and save" }).click();
  await expect(lib.getByText("Accepted")).toBeVisible();

  // accept the PostgreSQL rewrite, which the re-score says costs points
  const pg = page.locator(".bullet", { hasText: "Removed full table scans" });
  await pg.getByRole("button", { name: /Accept rewrite/ }).click();
  await expect(pg.getByText("Accepted")).toBeVisible();

  // re-score: both versions side by side, plus coverage counted in code
  await page.getByRole("button", { name: /Continue to re-score/ }).click();
  await expect(page.getByRole("meter", { name: "Match score" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Keyword coverage" })).toBeVisible();
  await expect(page.getByText(/required skills you have are on the page/)).toBeVisible();
  // grouped by where each skill stands, each one marked Required or Preferred
  const onResume = page.getByRole("region", { name: /^On your resume \(\d+\)$/ });
  await expect(onResume.locator(".skill", { hasText: "PostgreSQL" }).locator(".tier")).toHaveText("Required");
  const notShown = page.getByRole("region", { name: "You have it, not shown (1)" });
  await expect(notShown.locator(".skill", { hasText: "Redis" }).locator(".tier")).toHaveText("Preferred");
  await expect(page.getByRole("region", { name: "Not in your experience (2)" })).toBeVisible();

  // a change that lowers the score is flagged and undone in one click
  await expect(page.getByRole("heading", { name: "Changes that lower the score" })).toBeVisible();
  await page.getByRole("button", { name: "Undo change to b3" }).click();
  await expect(page.getByText("Original kept")).toBeVisible();
  await expect(page.getByText("Your changes have moved on since this score")).toBeVisible();
  await page.getByRole("button", { name: "Score again" }).click();
  await expect(page.getByRole("heading", { name: "Changes that lower the score" })).toHaveCount(0, { timeout: 20_000 });

  // export
  await page.getByRole("tab", { name: /Export/ }).click();
  await expect(page.getByText("Jordan_Sample_Resume_Larkspur_Freight.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Export PDF" }).click();
  await expect(page.getByText("PDF exported")).toBeVisible();
  await expect(page.getByRole("group", { name: "Application status" }).getByRole("button", { name: "Tailored" })).toHaveAttribute("aria-pressed", "true");
});

test("command bar opens with the shortcut and navigates", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Paste a job posting" })).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  const bar = page.getByRole("dialog", { name: "Command bar" });
  await expect(bar).toBeVisible();
  await page.keyboard.type("facts");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Facts bank" })).toBeVisible();
  await expect(bar).toBeHidden();
});

test("error state offers the next action", async ({ page }) => {
  await page.goto("/?fail=bad_key");
  await page.getByLabel("Job posting").fill(posting);
  await page.locator(".paste-row").getByRole("button", { name: /Tailor/ }).click();
  await expect(page.getByText("The API key was rejected")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Open Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});

test("manual baseline stopwatch records a timing", async ({ page }) => {
  await page.goto("/?screen=settings&empty=1");
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Stop and save" }).click();
  await expect(page.getByText("1 timing recorded")).toBeVisible();
});

test("theme switch and reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?screen=settings");
  await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const dur = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--dur").trim());
  expect(["0ms", "0s"]).toContain(dur);
});

test("facts import suggests facts and saves only what is accepted", async ({ page }) => {
  await page.goto("/?screen=facts&speed=10");
  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("TrailMap is used by 140 members.") });
  await expect(page.getByRole("heading", { name: "Suggested from notes.txt" })).toBeVisible();

  // A suggestion with a number the document lacks can't be accepted as is.
  const blocked = page.locator(".suggestion", { hasText: "2,000 monthly users" });
  await expect(blocked.getByText('Number "2,000" is not in the document.', { exact: false })).toBeVisible();
  await expect(blocked.getByRole("button", { name: "Accept" })).toBeDisabled();
  await blocked.getByRole("button", { name: "Reject" }).click();
  await expect(blocked).toHaveCount(0);

  // What the resume already says is tucked away, closed, with what covers it.
  const covered = page.locator(".covered-group");
  await expect(covered.locator("summary")).toHaveText("Already on your resume (1)");
  await expect(covered.getByText("Budget Bot parses CSV exports from 3 banks")).toBeHidden();
  await expect(page.locator(".suggestion", { hasText: "CSV exports" })).toHaveCount(0);
  await covered.locator("summary").click();
  await expect(covered.getByText("Budget Bot parses CSV exports from 3 banks")).toBeVisible();
  await expect(covered.getByText("b11")).toBeVisible();

  const good = page.locator(".suggestion", { hasText: "25 contributors" });
  await good.getByRole("button", { name: "Accept" }).click();
  await expect(page.locator('input[aria-label^="Edit fact"][value="TrailMap had 25 contributors on GitHub"]')).toBeVisible();

  // A page can lead on to its resume PDF.
  await page.getByLabel("Page to read").fill("jordan.example");
  await page.getByRole("button", { name: "Read page" }).click();
  await expect(page.getByRole("button", { name: "Read Resume (PDF)" })).toBeVisible();
});

test("jobs: refresh, filter, new badges, tailor a listing and mark one applied", async ({ page }) => {
  await page.goto("/?speed=10");
  await page.getByRole("button", { name: "Jobs" }).first().click();
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();

  // The cached list is two hours old, so opening the screen refreshes it.
  await expect(page.getByText("Updated just now")).toBeVisible({ timeout: 10_000 });
  const rows = page.locator(".jobs-table tbody tr");
  await expect(rows).toHaveCount(8);
  await expect(page.locator(".new-badge")).toHaveCount(2);
  await expect(rows.filter({ hasText: "Larkspur Freight" })).toContainText("Simplify, SpeedyApply");

  // Search and filters
  await page.getByPlaceholder("Search company, role or location").fill("backend");
  await expect(rows).toHaveCount(2);
  await page.getByLabel("Location").fill("remote");
  await expect(rows).toHaveCount(2);
  await page.getByLabel("Company").fill("morrow");
  await expect(rows).toHaveCount(1);
  await expect(page.getByText("1 of 8 match")).toBeVisible();
  await page.getByPlaceholder("Search company, role or location").fill("");
  await page.getByLabel("Location").fill("");
  await page.getByLabel("Company").fill("");
  await page.getByLabel("Date posted").selectOption({ label: "Past week" });
  await expect(rows).toHaveCount(5);
  await page.getByLabel("Date posted").selectOption({ label: "Any time" });

  // Mark applied: it goes into the tracker with its link.
  await page.getByRole("button", { name: "Mark Quillstone applied" }).click();
  await expect(rows.filter({ hasText: "Quillstone" }).getByText("Applied")).toBeVisible();

  // A Workday posting can't be read: the Tailor screen asks for a paste, with company and role filled in.
  await rows.filter({ hasText: "Northbeam Energy" }).getByRole("button", { name: "Tailor for this" }).click();
  await expect(page.getByText("Paste the posting to continue")).toBeVisible();
  await expect(page.getByLabel("Company")).toHaveValue("Northbeam Energy");
  await expect(page.getByLabel("Role")).toHaveValue("Backend Software Intern - Summer 2027");
  await expect(page.getByLabel("Job posting")).toHaveValue("");

  // A readable posting arrives filled in.
  await page.getByRole("button", { name: "Jobs" }).first().click();
  await rows.filter({ hasText: "Larkspur Freight" }).getByRole("button", { name: "Tailor for this" }).click();
  await expect(page.getByText(/Posting read from jobs.larkspur.example/)).toBeVisible();
  await expect(page.getByLabel("Job posting")).not.toHaveValue("");
  await expect(page.getByLabel("Role")).toHaveValue("Software Engineer Intern, Platform");

  await page.getByRole("button", { name: "Applications" }).first().click();
  await expect(page.getByRole("button", { name: "Open the Quillstone posting" })).toBeVisible();
});
