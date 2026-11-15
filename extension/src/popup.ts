/** The toolbar popup: who the profile is for, Autofill for the current tab, and a way to edit the profile. */
import type { AutofillResult } from "./content";
import { loadProfile, loadResume } from "./profile";

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
  who.textContent = name ? `${name}${resume ? " · resume attached" : " · no resume yet"}` : "Set up your profile first.";
  button.addEventListener("click", autofill);
  document.getElementById("edit")!.addEventListener("click", () => chrome.runtime.openOptionsPage());
}

start();
