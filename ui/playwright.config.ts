import { defineConfig } from "@playwright/test";

// Browser end-to-end tests of the interface against the in-memory mock backend.
// desktop.spec.ts opens the built page from file:// against the real Python bridge.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: "http://localhost:4173", viewport: { width: 1440, height: 900 }, trace: "off" },
  webServer: [
    {
      command: "npx vite build && npx vite preview --port 4173 --strictPort",
      url: "http://localhost:4173",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      // The real Python bridge behind a test-only HTTP front, for desktop.spec.ts.
      command: "uv run python -m tests.bridge_server --port 4174",
      cwd: "..",
      url: "http://127.0.0.1:4174/",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
