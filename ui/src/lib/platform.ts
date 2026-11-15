/** Native dialogs, clipboard and "show in folder", with plain browser fallbacks so the
 *  UI also runs in a normal browser (mock mode, screenshots, Playwright). */

import { call } from "./ipc";

/** True inside the desktop app. The app opens the built page from a file:// address and
 *  pywebview adds `window.pywebview` to it. The browser mock is always served over http,
 *  so neither is true there. The window URL carries no query string: on Windows a "?" in
 *  a file URL ends up in the file name and the page fails to load. */
export const inDesktop = typeof window !== "undefined" && (location.protocol === "file:" || window.pywebview !== undefined);

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!inDesktop) return "/Users/you/Documents/Resumes";
  return call<string | null>("pick_folder", { defaultPath: defaultPath ?? "" });
}

export async function pickTexFile(): Promise<string | null> {
  if (!inDesktop) return null;
  return call<string | null>("pick_tex_file");
}

/** Pick a program file, such as the claude or codex command. Null in the browser mock. */
export async function pickProgram(): Promise<string | null> {
  if (!inDesktop) return null;
  return call<string | null>("pick_program");
}

/**
 * Save the profile for the Tailor Autofill extension. The desktop app asks where
 * with a save dialog; the browser mock downloads it. The saved path, or null.
 */
export async function exportAutofill(): Promise<string | null> {
  if (inDesktop) return call<string | null>("export_autofill");
  const data = await call<Record<string, unknown>>("autofill_profile");
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "Tailor_Autofill_Profile.json" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "Tailor_Autofill_Profile.json";
}

export async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Some webviews only allow the clipboard API on https pages; fall back to a hidden textarea.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

export async function reveal(path: string): Promise<void> {
  if (!inDesktop) return;
  await call<void>("reveal", { path });
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? "⌘" : "Ctrl+";
