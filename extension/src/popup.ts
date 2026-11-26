/** The toolbar popup: who the profile is for, Autofill for the current tab, and a way to edit the profile. */
import type { AutofillResult } from "./content";
import { loadProfile, loadResume } from "./profile";
import { loadSettings } from "./settings";
import { applyTheme } from "./theme";

applyTheme();

const who = document.getElementById("who")!;
const result = document.getElementById("result")!;
const button = document.getElementById("autofill") as HTMLButtonElement;

async function ask(tabId: number): Promise<AutofillResult | undefined> {
  return chrome.tabs.sendMessage(tabId, { type: "autofill" });
}

/**
 * On the known job sites the content script is already in the page. Anywhere
 * else it's added to this one tab now, which the activeTab permission allows
 * because the user clicked; the extension doesn't need access to every site.
 */
async function autofill(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  button.disabled = true;
  result.textContent = "Filling…";
  try {
    let answer: AutofillResult | undefined;
    try {
      answer = await ask(tab.id);
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
      answer = await ask(tab.id);
    }
    result.textContent = answer?.text ?? "No form found on this page.";
  } catch {
    result.textContent = "This page can't be filled (Chrome's own pages and the Web Store are off limits).";
  } finally {
    button.disabled = false;
  }
}

async function start(): Promise<void> {
  const [profile, resume] = await Promise.all([loadProfile(), loadResume()]);
  const name = `${profile.firstName} ${profile.lastName}`.trim();
  who.textContent = name ? `${name} · ${profile.email || "no email yet"}` : "Set up your profile first.";
  const pill = document.getElementById("resume-pill")!;
  pill.textContent = resume ? "Resume attached" : "No resume";
  pill.classList.toggle("positive", Boolean(resume));
  button.addEventListener("click", autofill);
  document.getElementById("edit")!.addEventListener("click", () => chrome.runtime.openOptionsPage());
  const settings = await loadSettings();
  if (settings.debug) showDebug(settings.debugValues);
}

/**
 * Debug mode's two buttons. The popup writes the clipboard itself: the click
 * here is what lets it. "Copy page state" records every field on the page as
 * it is, without filling anything, for comparing a page another tool filled.
 */
function showDebug(values: boolean): void {
  const box = document.getElementById("debug")!;
  const line = document.getElementById("debug-result")!;
  box.hidden = false;
  const copy = async (data: unknown, what: string) => {
    if (!data) {
      line.textContent = `No ${what} yet.`;
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    line.textContent = `Copied the ${what}.`;
  };
  document.getElementById("copy-last")!.addEventListener("click", async () => {
    const got = await chrome.storage.local.get(["lastDebug"]);
    await copy(got.lastDebug, "debug report");
  });
  document.getElementById("copy-state")!.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    try {
      let state = await chrome.tabs.sendMessage(tab.id, { type: "pageState", values });
      if (!state) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
        state = await chrome.tabs.sendMessage(tab.id, { type: "pageState", values });
      }
      await copy(state, "page state");
    } catch {
      line.textContent = "This page can't be read.";
    }
  });
}

start();
