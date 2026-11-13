import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// The build is one self-contained index.html: scripts, styles, fonts and
// pdf.js are all inline. The desktop app loads it from a file:// URL, so no
// local web server or open port is needed. (Module scripts fetched from
// file:// are blocked by the webviews; inline ones run fine.)
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: "./",
  clearScreen: false,
  // The mock backend reads the sample posting from the repo's tests/fixtures.
  server: { port: 1420, strictPort: true, fs: { allow: [".."] } },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 6000,
    // Inline every asset (fonts included) as a data URL.
    assetsInlineLimit: 100_000_000,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
