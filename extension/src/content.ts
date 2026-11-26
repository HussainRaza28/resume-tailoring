/**
 * Runs in the job site's page. On the known sites it adds a floating Autofill
 * button; anywhere, the popup's Autofill button sends it a message. Either way
 * it fills the form once, shows the summary and highlights what's left. It
 * never submits.
 */
import { type DebugReport, finishDebug, noteInput, pageState, startDebug } from "./fill/debug";
import { fillPage } from "./fill/engine";
import { startTrusted, stopTrusted, useSynthetic } from "./fill/input";
import { siteFor } from "./fill/sites";
import { loadProfile, loadResume, resumeFile } from "./profile";
import { loadSettings } from "./settings";
import { PAGE_STYLE, highlight, logReport, showSummary } from "./summary";

declare global {
  interface Window {
    __tailorAutofill?: boolean;
  }
}

export interface AutofillResult {
  filled: number;
  left: number;
  text: string;
}

/** Put the debug report on the clipboard; true when the browser allowed it. */
async function copyReport(report: DebugReport): Promise<boolean> {
  const text = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function autofill(): Promise<AutofillResult | null> {
  const [profile, stored, settings] = await Promise.all([loadProfile(), loadResume(), loadSettings()]);
  const site = siteFor(location.href);
  if (settings.debug) startDebug(settings.debugValues);
  // Real typing for the whole run on the sites that need it; the debugger is detached right after.
  if (settings.realTyping && site?.name === "Workday") await startTrusted();
  else useSynthetic(settings.realTyping ? "not needed on this site" : "real typing is off in the options");
  noteInput();
  let report;
  try {
    report = await fillPage(document, profile, stored ? resumeFile(stored) : null, site);
  } finally {
    await stopTrusted();
  }
  const debug = finishDebug();
  if (debug) {
    await chrome.storage.local.set({ lastDebug: debug });
    console.log("Tailor Autofill debug report", debug);
  }
  // A frame with no form at all (an ad, a video) stays quiet.
  if (!report.filled.length && !report.left.length) return null;
  highlight(report.left);
  logReport(report);
  const banner = showSummary(document, report, debug ? { copy: () => copyReport(debug), copied: await copyReport(debug) } : undefined);
  return { filled: report.filled.length, left: report.left.length, text: banner.shadowRoot!.querySelector(".text")!.textContent ?? "" };
}

function addButton(): void {
  const host = document.createElement("div");
  host.id = "tailor-autofill-button";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${PAGE_STYLE}
      button { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; display: inline-flex; align-items: center;
               gap: 8px; height: 40px; padding: 0 18px 0 14px; border-radius: 999px; cursor: pointer;
               border: 1px solid rgba(255, 255, 255, 0.08); background: #171615; color: #f4f4f2;
               font: 500 14px/1 var(--font); box-shadow: 0 18px 40px -18px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(0, 0, 0, 0.2);
               transition: transform 120ms cubic-bezier(0.22, 1, 0.36, 1), background 220ms; }
      button:hover { background: #242220; }
      button:active { transform: scale(0.97); }
      button:disabled { opacity: 0.6; cursor: progress; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #c6f24e; }
    </style>
    <button type="button" title="Fill this form from your Tailor profile. Nothing is submitted."><span class="dot"></span>Autofill</button>`;
  const button = root.querySelector("button")!;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await autofill();
    } finally {
      button.disabled = false;
    }
  });
  document.body.append(host);
}

// The popup may inject this script into a page that already has it.
if (!window.__tailorAutofill) {
  window.__tailorAutofill = true;
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    // Debug: every field on the page as it is now, nothing filled. The popup copies it.
    if (message?.type === "pageState") {
      if (!document.querySelector("input, select, textarea, button[aria-haspopup='listbox']")) return false;
      reply(pageState(document, !!message.values));
      return false;
    }
    if (message?.type !== "autofill") return false;
    autofill().then((result) => {
      if (result) reply(result);
    });
    // Keep the channel open for the answer, sent only by a frame that has a form.
    return true;
  });
  // The floating button only on the job sites the extension knows, and only in the frame with the form.
  if (siteFor(location.href) && document.querySelector("form, input, select, textarea")) addButton();
}
