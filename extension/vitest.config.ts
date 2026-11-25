import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Filling reads each field back and pauses between fields, as on a real page,
    // so a test that fills several whole forms takes a few seconds.
    testTimeout: 30_000,
  },
});
