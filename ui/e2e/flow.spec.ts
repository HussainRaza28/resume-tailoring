import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const posting = readFileSync(new URL("../../tests/fixtures/sample_posting.txt", import.meta.url), "utf8");
const mod = process.platform === "darwin" ? "Meta" : "Control";

test("paste, score, add a note, rewrite, done", async ({ page }) => {
  await page.goto("/?speed=10");
  await expect(page.getByRole("heading", { name: "Paste a job posting" })).toBeVisible();
  await page.getByLabel("Job posting").fill(posting);
  await page.getByLabel("Job posting").press(`${mod}+Enter`);

  // Score: the ATS score and three red flags, nothing else. The rewrite waits for the user.
  await expect(page.getByRole("tab", { name: /Score/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("meter", { name: "ATS score" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("list", { name: "Red flags" }).getByRole("listitem")).toHaveCount(3);
  await expect(page.locator(".bullet")).toHaveCount(0);
  await expect(page.locator(".run-title")).toContainText("Larkspur Freight");
  await expect(page.locator(".run-title")).toContainText("Software Engineer Intern, Platform");

  // The note becomes facts the rewrite can use: it unblocks the pull-request bullet.
  await page.getByLabel("Anything to add?").fill("I reviewed 12 pull requests that summer. Also ran the weekly demo.");
  await page.getByRole("button", { name: /^Rewrite/ }).click();
  await expect(page.getByRole("tab", { name: /Rewrite/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".bullet").first()).toBeVisible({ timeout: 20_000 });
  const prs = page.locator(".bullet", { hasText: "Reviewed 12 pull requests" });
  await expect(prs.getByRole("button", { name: "Accept" })).toBeEnabled();
  await page.getByRole("tab", { name: /Score/ }).click();
  await expect(page.getByText("Added 2 facts ·")).toBeVisible();
  await page.getByRole("tab", { name: /Rewrite/ }).click();

  // Only Accept or Keep original. A style finding is a warning: Accept stays enabled.
  const styled = page.locator(".bullet", { hasText: "Seamlessly unified" });
  await expect(styled.getByText(/Stock word/)).toBeVisible();
  await expect(styled.getByText("Check style")).toBeVisible();
  await expect(styled.getByRole("button", { name: "Accept" })).toBeEnabled();
  await expect(page.getByRole("button", { name: /Edit/ })).toHaveCount(0);

  // keyboard: right arrow accepts the focused bullet
  await page.locator("body").click({ position: { x: 5, y: 500 } });
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".bullet").first().getByText("Accepted")).toBeVisible();
  await prs.getByRole("button", { name: "Accept" }).click();
  const lib = page.locator(".bullet", { hasText: "library patrons" });
  await lib.getByRole("button", { name: "Keep original" }).click();
  await expect(lib.getByText("Kept original")).toBeVisible();

  // Done: before and after, coverage, export. No per-change breakdown.
  await page.getByRole("button", { name: /^Done/ }).click();
  await expect(page.getByRole("tab", { name: /Done/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".score-compare")).toHaveText("57 → 65", { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Keyword coverage" })).toBeVisible();
  const onResume = page.getByRole("region", { name: /^On your resume \(\d+\)$/ });
  await expect(onResume.locator(".skill", { hasText: "PostgreSQL" }).locator(".tier")).toHaveText("Required");
  await expect(page.getByText("Changes that lower the score")).toHaveCount(0);
  await expect(page.getByText("Jordan_Sample_Resume_Larkspur_Freight.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Export PDF" }).click();
  await expect(page.getByText("PDF exported")).toBeVisible();
});

test("undoing the note removes its facts", async ({ page }) => {
  await page.goto("/?speed=10");
  await page.getByLabel("Job posting").fill(posting);
  await page.getByLabel("Job posting").press(`${mod}+Enter`);
  await expect(page.getByRole("meter", { name: "ATS score" })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Anything to add?").fill("I reviewed 12 pull requests that summer.");
  await page.getByRole("button", { name: /^Rewrite/ }).click();
  await expect(page.locator(".bullet").first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: /Score/ }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText(/Added \d+ fact/)).toHaveCount(0);
  await page.getByRole("button", { name: "Facts bank" }).first().click();
  await expect(page.locator('input[value="I reviewed 12 pull requests that summer"]')).toHaveCount(0);
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
  await expect(rows).toHaveCount(9, { timeout: 10_000 });
  await expect(page.locator(".new-badge")).toHaveCount(2);
  await expect(rows.filter({ hasText: "Larkspur Freight" })).toContainText("Simplify, SpeedyApply");

  // PhD and Master's roles are hidden until asked for.
  await expect(rows.filter({ hasText: "Research Intern, PhD" })).toHaveCount(0);
  await page.getByLabel(/Show PhD and Master's roles/).check();
  await expect(rows).toHaveCount(10);
  await page.getByLabel(/Show PhD and Master's roles/).uncheck();

  // "United States" matches every US listing, not just ones that say so.
  await page.getByLabel("Location").fill("United States");
  await expect(rows).toHaveCount(7);
  await expect(rows.filter({ hasText: "Maple Systems" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "Brightline Labs" })).toHaveCount(0);
  await page.getByLabel("Location").fill("");

  // Search and filters
  await page.getByPlaceholder("Search company, role or location").fill("backend");
  await expect(rows).toHaveCount(3);
  await page.getByLabel("Location").fill("remote");
  await expect(rows).toHaveCount(2);
  await page.getByLabel("Company").fill("morrow");
  await expect(rows).toHaveCount(1);
  await expect(page.getByText("1 match")).toBeVisible();
  await page.getByPlaceholder("Search company, role or location").fill("");
  await page.getByLabel("Location").fill("");
  await page.getByLabel("Company").fill("");
  await page.getByLabel("Date posted").selectOption({ label: "Past week" });
  await expect(rows).toHaveCount(6);
  await page.getByLabel("Date posted").selectOption({ label: "Any time" });

  // Each row links to its posting.
  await expect(page.getByRole("button", { name: /Open the Quillstone posting/ })).toBeVisible();

  // Mark applied: it goes into the tracker with its link.
  await page.getByRole("button", { name: "Mark Quillstone applied" }).click();
  await expect(rows.filter({ hasText: "Quillstone" }).getByText("Applied")).toBeVisible();

  // A Workday posting can't be read: the Tailor screen asks for a paste, with company and role filled in.
  await rows.filter({ hasText: "Northbeam Energy" }).getByRole("button", { name: "Tailor" }).click();
  await expect(page.getByText("Paste the posting to continue")).toBeVisible();
  await expect(page.getByLabel("Company")).toHaveValue("Northbeam Energy");
  await expect(page.getByLabel("Role")).toHaveValue("Backend Software Intern - Summer 2027");
  await expect(page.getByLabel("Job posting")).toHaveValue("");

  // A readable posting arrives filled in, and the run keeps its link.
  await page.getByRole("button", { name: "Jobs" }).first().click();
  await rows.filter({ hasText: "Larkspur Freight" }).getByRole("button", { name: "Tailor" }).click();
  await expect(page.getByText(/Posting read from jobs.larkspur.example/)).toBeVisible();
  await expect(page.getByLabel("Job posting")).not.toHaveValue("");
  await expect(page.getByLabel("Role")).toHaveValue("Software Engineer Intern, Platform");
  await page.getByLabel("Job posting").press(`${mod}+Enter`);
  await expect(page.locator(".run-title").getByRole("button", { name: /View posting/ })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Applications" }).first().click();
  await expect(page.getByRole("button", { name: "Open the Quillstone posting" })).toBeVisible();
});

test("settings: the ChatGPT (Codex) provider shows its sign-in", async ({ page }) => {
  await page.goto("/?screen=settings");
  await page.getByRole("group", { name: "Provider" }).getByRole("button", { name: "ChatGPT (Codex)" }).click();
  await expect(page.getByText("Installed · signed in with ChatGPT")).toBeVisible();
  await expect(page.getByLabel("Codex model")).toHaveAttribute("placeholder", "Codex's default");
});
