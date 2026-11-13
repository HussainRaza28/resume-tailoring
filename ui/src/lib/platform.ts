/** Native dialogs, clipboard and "show in folder", with plain browser fallbacks so the
 *  UI also runs in a normal browser (mock mode, screenshots, Playwright). */

import { call } from "./ipc";

export const inDesktop = typeof window !== "undefined" && new URLSearchParams(location.search).get("desktop") === "1";

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!inDesktop) return "/Users/you/Documents/Resumes";
  return call<string | null>("pick_folder", { defaultPath: defaultPath ?? "" });
}

export async function pickTexFile(): Promise<string | null> {
  if (!inDesktop) return null;
  return call<string | null>("pick_tex_file");
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
