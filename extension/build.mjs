// Builds the extension into dist/: one bundled script per entry point, plus the
// static files (manifest and HTML). Chrome loads dist/ with "Load unpacked".
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
cpSync("static", "dist", { recursive: true });

await build({
  entryPoints: { content: "src/content.ts", popup: "src/popup.ts", options: "src/options.ts", background: "src/background.ts" },
  bundle: true,
  // Content scripts can't load modules, so each entry becomes one plain script.
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  logLevel: "info",
});
