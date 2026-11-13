import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const posting = readFileSync(new URL("../../tests/fixtures/sample_posting.txt", import.meta.url), "utf8");
const mod = process.platform === "darwin" ? "Meta" : "Control";

test("paste, tailor, decide, review and export", async ({ page }) => {
  await page.goto("/?speed=10");
  await expect(page.getByRole("heading", { name: "Paste a job posting" })).toBeVisible();
  await page.getByLabel("Job posting").fill(posting);
  await page.getByLabel("Job posting").press(`${mod}+Enter`);

  // red flags then rewrites stream in
  await expect(page.getByRole("tab", { name: /Rewrite/ })).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  await expect(page.locator(".bullet").first()).toBeVisible();

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

  // review shows score before and after plus deterministic coverage
  await page.getByRole("button", { name: /Continue to review/ }).click();
  await expect(page.getByRole("meter", { name: "Match score" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Keyword coverage" })).toBeVisible();
  await expect(page.getByText(/required skills you have are on the page/)).toBeVisible();

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
