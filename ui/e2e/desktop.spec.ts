import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The built interface, opened from file:// as the desktop app opens it, talking
// to the real Python bridge. pywebview is replaced by a stand-in that sends each
// call to tests/bridge_server.py and replays the streamed events it returns.

const page_url = new URL("../dist/index.html", import.meta.url).href;
const posting = readFileSync(new URL("../../tests/fixtures/sample_posting.txt", import.meta.url), "utf8");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { pywebview: unknown }).pywebview = {
      api: {
        call: async (command: string, args: Record<string, unknown>) => {
          const res = await fetch("http://127.0.0.1:4174/call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ command, args }),
          });
          const { reply, events } = await res.json();
          const channel = args?.onEvent as string | undefined;
          for (const e of events) window.__tailorEmit?.(channel ?? "", e);
          return reply;
        },
      },
    };
  });
});

test("the built page runs from file:// against the Python backend", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(page_url);
  expect(fileURLToPath(page_url)).toContain("dist");
  // Opened the way the app opens it: no query string, and the page picks the Python bridge.
  expect(new URL(page.url()).search).toBe("");
  await expect(page.locator("html")).toHaveAttribute("data-backend", "python");

  // The base resume compiles and the whole page fits the preview pane.
  const canvas = page.getByRole("img", { name: "Resume preview, page 1" });
  await expect(canvas).toBeVisible({ timeout: 90_000 });
  const desk = page.locator(".desk");
  const fits = async () => {
    const c = (await canvas.boundingBox())!;
    const d = (await desk.boundingBox())!;
    return c.width <= d.width + 1 && c.height <= d.height + 1 && c.y >= d.y - 1 && c.y + c.height <= d.y + d.height + 1;
  };
  expect(await fits()).toBe(true);

  // Re-fit when the window changes shape: short and wide, then tall and narrow.
  await page.setViewportSize({ width: 1600, height: 720 });
  await expect.poll(fits).toBe(true);
  await page.setViewportSize({ width: 1180, height: 1000 });
  await expect.poll(fits).toBe(true);

  // Paste a posting and run the demo flow through the real pipeline.
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.getByLabel("Job posting").fill(posting);
  await page.getByLabel("Job posting").press(`${mod}+Enter`);
  await expect(page.getByRole("tab", { name: /Rewrite/ })).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });

  // The Demo provider rewrites the vague library bullet; accept it.
  const lib = page.locator(".bullet", { hasText: "Supported patrons" });
  await lib.getByRole("button", { name: /Accept rewrite/ }).click();
  await expect(lib.getByText("Accepted")).toBeVisible();

  // Re-score, then export a one-page PDF into the folder set in Settings.
  await page.getByRole("button", { name: /Continue to re-score/ }).click();
  await expect(page.getByRole("meter", { name: "Match score" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("tab", { name: /Export/ }).click();
  await expect(page.getByText("Jordan_Sample_Resume_Larkspur_Freight.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Export PDF" }).click();
  await expect(page.getByText("PDF exported")).toBeVisible({ timeout: 90_000 });
  expect(errors).toEqual([]);
});

test("facts import reads a real file through the Python backend", async ({ page }) => {
  await page.goto(page_url);
  await page.getByRole("button", { name: /Facts bank/ }).first().click();
  const notes = "TrailMap is used by 140 members of the university hiking club.\nTrailMap had 25 contributors on GitHub over 2 semesters.";
  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(notes) });
  // The resume already says the first one, so only the second is offered.
  const row = page.locator(".suggestion", { hasText: "25 contributors" });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".suggestion", { hasText: "140 members" })).toHaveCount(0);
  await expect(page.locator(".covered-group summary")).toHaveText("Already on your resume (1)");
  await row.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByLabel(/Edit fact f/).first()).toHaveValue(/25 contributors on GitHub/);
});
