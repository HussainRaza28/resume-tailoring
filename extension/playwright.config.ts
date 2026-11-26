import { defineConfig } from "@playwright/test";

/**
 * Browser tests with the built extension loaded in Chromium (live/). They
 * need `npm run build` first; `npm run live` does both.
 */
export default defineConfig({
  testDir: "live",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  use: { trace: "off" },
});
