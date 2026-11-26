/**
 * Autofill's own settings, kept with the profile in chrome.storage.local.
 *
 * - realTyping: type and click with real input through Chrome's debugger API
 *   (on by default). Off, Autofill dispatches events as before.
 * - debug: after each Autofill run, copy a report of every field it touched
 *   (off by default).
 * - debugValues: include the values themselves in that report (off by
 *   default: only lengths and whether they match).
 */
export interface Settings {
  realTyping: boolean;
  debug: boolean;
  debugValues: boolean;
}

export const DEFAULT_SETTINGS: Settings = { realTyping: true, debug: false, debugValues: false };

export async function loadSettings(): Promise<Settings> {
  try {
    const got = await chrome.storage.local.get(["settings"]);
    return { ...DEFAULT_SETTINGS, ...(got.settings ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}
