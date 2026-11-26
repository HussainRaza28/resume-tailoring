/**
 * Debug mode: what Autofill did to each field, and what the page shows
 * afterwards, as JSON the person can paste back to whoever is fixing a site.
 *
 * For every field Autofill touched: its label, automation id, element and
 * type, the kind of widget Autofill took it for, how it typed (trusted input
 * or dispatched events), the value it set, the value read back from the
 * element and from what's shown (chips, button text, a date's display), the
 * outcome, aria-invalid, the error text under it, whether focus stayed in it
 * after typing, and whether the page replaced the element while it was being
 * filled.
 *
 * Values are personal, so by default only their length and whether they
 * match are recorded. Raw values are included only when the person turns on
 * "Include values" in the options. Labels and Workday's own error messages
 * are always included: they're the page's words, not the person's.
 *
 * `pageState` records the same for every field on the page without filling
 * anything, so the page can be captured after another tool (or a person) has
 * filled it, and the two compared.
 */
import { live, replaced } from "./live";
import { inputMode } from "./input";
import { buttonValue, chipsIn, dateSegments, fieldError, fieldOf, lastTrace, workdayLabel } from "./workdayWidgets";

export type WidgetKind = "text" | "textarea" | "segmented date" | "multi-select" | "dropdown" | "checkbox" | "radio" | "select" | "file" | "other";

/** A value as recorded: its length and emptiness, and the value itself only when raw values are on. */
export interface Shown {
  length: number;
  empty: boolean;
  value?: string;
}

export interface FieldRecord {
  label: string;
  /** The formField-* wrapper's automation id, and the element's own when it has one. */
  formField: string | null;
  automationId: string | null;
  id: string;
  tag: string;
  type: string | null;
  kind: WidgetKind;
  method: "trusted" | "synthetic" | "none";
  outcome: string;
  set: Shown | null;
  /** The element's own value as it is now (the element found again if the page replaced it). */
  readBack: Shown | null;
  /** What the field shows: chips, a dropdown's button text, a date's display segments. */
  display: Shown | null;
  /** Whether what's read back or shown is the value that was set (case and spacing ignored). */
  matches: boolean | null;
  ariaInvalid: string | null;
  errorText: string;
  focusAfterTyping: boolean | null;
  /** Whether the page replaced the element while Autofill filled it. */
  replaced: boolean;
  attempts: number;
  steps: string[];
}

export interface DebugReport {
  tool: "Tailor Autofill debug";
  version: string;
  when: string;
  host: string;
  step: string;
  mode: "after autofill" | "page state";
  input: { mode: string; reason: string };
  rawValues: boolean;
  bannerErrors: string[];
  fields: FieldRecord[];
}

let session: { raw: boolean; fields: FieldRecord[]; input: ReturnType<typeof inputMode> | null } | null = null;

export function startDebug(raw: boolean): void {
  session = { raw, fields: [], input: null };
}

/** Note how this run types, once it's known (the debugger is detached again before the report is made). */
export function noteInput(): void {
  if (session) session.input = { ...inputMode() };
}

export function debugging(): boolean {
  return session !== null;
}

function shown(value: string | null | undefined, raw: boolean): Shown | null {
  if (value === null || value === undefined) return null;
  const v = String(value);
  return raw ? { length: v.length, empty: v.trim() === "", value: v } : { length: v.length, empty: v.trim() === "" };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function widgetKind(el: Element): WidgetKind {
  if (el.matches("[data-automation-id='dateInputWrapper']") || el.closest("[data-automation-id='dateInputWrapper']")) return "segmented date";
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLButtonElement && el.getAttribute("aria-haspopup") === "listbox") return "dropdown";
  if (el instanceof HTMLInputElement) {
    if (el.getAttribute("data-uxi-widget-type") === "selectinput" || el.dataset.automationId === "searchBox") return "multi-select";
    if (el.type === "checkbox") return "checkbox";
    if (el.type === "radio") return "radio";
    if (el.type === "file") return "file";
    return "text";
  }
  if (el.getAttribute("role") === "combobox") return "dropdown";
  return "other";
}

/** The element's own value, and what the field shows, as they are now. */
function readField(el: HTMLElement, kind: WidgetKind): { own: string | null; display: string | null } {
  const field = fieldOf(el);
  switch (kind) {
    case "segmented date": {
      const wrapper = el.closest<HTMLElement>("[data-automation-id='dateInputWrapper']") ?? el;
      const { month, year } = dateSegments(wrapper);
      const own = [month?.value, year?.value].filter((x) => x !== undefined).join("/");
      const display = [month, year]
        .filter(Boolean)
        .map((x) => x!.parentElement?.querySelector("[data-automation-id$='-display']")?.textContent?.trim() ?? "")
        .join("/");
      return { own, display };
    }
    case "multi-select":
      return { own: (el as HTMLInputElement).value, display: chipsIn(field).join(", ") };
    case "dropdown":
      return { own: el.getAttribute("value"), display: buttonValue(el) };
    case "checkbox":
    case "radio":
      return { own: String((el as HTMLInputElement).checked), display: null };
    case "select":
      return { own: (el as HTMLSelectElement).value, display: (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "" };
    case "file":
      return { own: String(((el as HTMLInputElement).files?.length ?? 0) > 0), display: null };
    default:
      return { own: (el as HTMLInputElement).value ?? null, display: null };
  }
}

function describe(original: HTMLElement, value: string | null, outcome: string, raw: boolean, method: FieldRecord["method"]): FieldRecord {
  const el = live(original);
  const kind = widgetKind(el);
  const { own, display } = readField(el, kind);
  const field = fieldOf(el);
  const t = lastTrace();
  let matches: boolean | null = null;
  if (value !== null && value !== "") {
    const wanted = squash(value);
    const seen = [own, display].filter((x): x is string => x !== null).map(squash);
    if (kind === "segmented date") {
      // "06/2025" set, display "06/2025" (or "2025" for a year alone): compare the numbers.
      const parts = (x: string) => x.split("/").map((p) => Number(p)).join("/");
      matches = display !== null && parts(display) === parts(value);
    } else {
      matches = seen.some((x) => x === wanted || (x !== "" && x.includes(wanted)));
    }
  }
  return {
    label: workdayLabel(el),
    formField: field?.dataset.automationId ?? null,
    automationId: el.getAttribute("data-automation-id"),
    id: el.id,
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute("type"),
    kind,
    method,
    outcome,
    set: shown(value, raw),
    readBack: shown(own, raw),
    display: shown(display, raw),
    matches,
    ariaInvalid: el.getAttribute("aria-invalid") ?? field?.querySelector("[aria-invalid]")?.getAttribute("aria-invalid") ?? null,
    errorText: fieldError(field),
    focusAfterTyping: method === "none" ? null : t.focusAfterTyping,
    replaced: replaced(original),
    attempts: method === "none" ? 0 : t.attempts,
    steps: method === "none" ? [] : [...t.steps],
  };
}

/** Record a field Autofill acted on. Does nothing unless Debug mode is on for this run. */
export function recordField(original: HTMLElement, value: string | null, outcome: string): void {
  if (!session) return;
  const method = value === null ? "none" : lastTrace().method;
  session.fields.push(describe(original, value, outcome, session.raw, method));
}

function meta(mode: DebugReport["mode"], raw: boolean, fields: FieldRecord[], input = inputMode()): DebugReport {
  const step = document.querySelector("[data-automation-id='progressBarActiveStep']")?.textContent?.trim() ?? "";
  const banner = Array.from(document.querySelectorAll("[data-automation-id*='errorBanner' i], [data-automation-id='errorHeading']")).map(
    (x) => x.textContent?.replace(/\s+/g, " ").trim() ?? "",
  );
  let version = "";
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    // Tests run without the extension runtime.
  }
  return {
    tool: "Tailor Autofill debug",
    version,
    when: new Date().toISOString(),
    host: location.hostname,
    step,
    mode,
    input: { mode: input.mode, reason: input.reason },
    rawValues: raw,
    bannerErrors: banner.filter(Boolean),
    fields,
  };
}

/** End the run's recording and return the report, with every field's state read once more at the end. */
export function finishDebug(): DebugReport | null {
  if (!session) return null;
  const { raw, fields, input } = session;
  session = null;
  return meta("after autofill", raw, fields, input ?? inputMode());
}

/**
 * Every field on the page as it is now, without filling anything: for
 * capturing a page after another tool or a person filled it.
 */
export function pageState(root: ParentNode, raw: boolean): DebugReport {
  const seen = new Set<Element>();
  const fields: FieldRecord[] = [];
  const controls = root.querySelectorAll<HTMLElement>(
    "[data-automation-id='dateInputWrapper'], input, textarea, select, button[aria-haspopup='listbox'], [role='combobox']",
  );
  for (const el of Array.from(controls)) {
    if (seen.has(el) || el.closest("[data-automation-id='dateInputWrapper']") !== null && !el.matches("[data-automation-id='dateInputWrapper']")) continue;
    if (el instanceof HTMLInputElement && (el.type === "hidden" || (!el.id && !el.name && el.parentElement?.querySelector(":scope > button[aria-haspopup='listbox']")))) continue;
    if (!el.closest("[data-automation-id^='formField-']") && !(el instanceof HTMLInputElement && el.type === "checkbox")) continue;
    seen.add(el);
    fields.push(describe(el, null, "not touched", raw, "none"));
  }
  return meta("page state", raw, fields);
}
