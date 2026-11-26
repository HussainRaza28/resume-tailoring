/**
 * Fill the form on a page from the profile.
 *
 * Walks every visible field in page order, works out what it asks for, and
 * answers it. It never submits, never clicks Next or Save, never ticks a
 * consent box, and never overwrites a field that already has an answer.
 * Open questions ("Why do you want to work here?") are left blank on purpose.
 *
 * The report lists what was filled and what was left for the person: fields
 * it couldn't match, open questions, and fields the profile has no answer for.
 * It also lists fields skipped on purpose (nothing to put there, such as the
 * end date of a current role) and fields whose value didn't stick when read
 * back.
 *
 * Fields are filled one at a time with a short pause between them, so a page
 * that re-renders as it goes (SuccessFactors adding a row) doesn't drop values.
 */
import type { Profile } from "../profile";
import {
  type Control,
  hasValue,
  isFillable,
  isVisible,
  labelOf,
  setButtonChoice,
  setChoice,
  setCombobox,
  setFile,
  setSearchBox,
  setDatePicker,
  setSelect,
  setTextChecked,
  datePickerValue,
  isDatePicker,
} from "./dom";
import { dateForField, patternFor, wantsFullDate } from "./dates";
import {
  ENTRY_KEYS,
  type FieldKey,
  OPTIONAL_KEYS,
  keyForLabel,
  keyInSection,
  looksLikeEssay,
  normalize,
  profileDate,
  valueFor,
} from "./keys";
import type { Site } from "./sites";
import { type Taken, aliasesFor, pickFromListbox, pickFromSearch } from "./workdayWidgets";

export interface FillReport {
  filled: HTMLElement[];
  /** Fields left for the person, to highlight. A radio group is reported as its container. */
  left: HTMLElement[];
  /** Fields that already had an answer and were left as they were. */
  already: number;
  /** Fields skipped on purpose: nothing to put there (a current role's end date, no middle name). */
  skipped?: HTMLElement[];
  /** Fields that were set but didn't keep the value when read back. Also in ``left``. */
  failed?: HTMLElement[];
  /**
   * Fields that show a value the page didn't take: a Workday date that still
   * says it's required, a search list with typed text and no chosen item, a
   * field marked invalid. Retried once first. Also in ``left``.
   */
  notAccepted?: HTMLElement[];
  /** The label each reported field was matched by, for the summary. */
  labels?: Map<HTMLElement, string>;
}

export interface FillOptions {
  /** Pause between fields, in milliseconds, so a page that re-renders can catch up. */
  pauseMs?: number;
}

type Candidate =
  | { kind: "control"; el: Control }
  | { kind: "group"; el: HTMLElement; inputs: HTMLInputElement[] }
  | { kind: "buttons"; el: HTMLElement; buttons: HTMLButtonElement[] }
  | { kind: "combobox"; el: HTMLElement }
  /** A SAP UI5 date picker web component. */
  | { kind: "datepicker"; el: HTMLElement };

const YES_NO = new Set(["yes", "no"]);

/** Every field on the page, once each, in page order. Radio groups and Yes/No button pairs count as one. */
export function candidates(root: ParentNode): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<Element>();
  const nodes = root.querySelectorAll<HTMLElement>("input, select, textarea, button, [role='combobox'], [ui5-date-picker], ui5-date-picker");
  for (const el of Array.from(nodes)) {
    if (seen.has(el) || !isVisible(el)) continue;
    if (isDatePicker(el) || el.hasAttribute("ui5-date-picker")) {
      seen.add(el);
      out.push({ kind: "datepicker", el });
      continue;
    }
    // A searchable dropdown: an input or button with role combobox, or a button that opens a list box.
    if (el.getAttribute("role") === "combobox" || (el instanceof HTMLButtonElement && el.getAttribute("aria-haspopup") === "listbox")) {
      seen.add(el);
      out.push({ kind: "combobox", el });
      continue;
    }
    if (el instanceof HTMLButtonElement) {
      // Two buttons reading Yes and No answer a question (Ashby).
      const parent = el.parentElement;
      const pair = parent ? Array.from(parent.querySelectorAll<HTMLButtonElement>(":scope > button")) : [];
      const words = pair.map((b) => normalize(b.textContent ?? ""));
      if (pair.length === 2 && words.every((w) => YES_NO.has(w)) && parent) {
        pair.forEach((b) => seen.add(b));
        out.push({ kind: "buttons", el: parent, buttons: pair });
      }
      continue;
    }
    if (!isFillable(el)) continue;
    // Workday keeps a dropdown's chosen value id in a text input beside its button
    // (<button aria-haspopup="listbox"> then <input type="text" value="bc33…">). It's not a question.
    if (el instanceof HTMLInputElement && !el.id && !el.name && el.parentElement?.querySelector(":scope > button[aria-haspopup='listbox']")) continue;
    if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
      const group = groupOf(el, root);
      group.forEach((x) => seen.add(x));
      // A single checkbox is a consent or an agreement: always the person's call.
      if (el.type === "checkbox" && group.length === 1) {
        out.push({ kind: "control", el });
        continue;
      }
      out.push({ kind: "group", el: el.closest("fieldset, [role='radiogroup'], [role='group']") ?? el.parentElement ?? el, inputs: group });
      continue;
    }
    seen.add(el);
    out.push({ kind: "control", el });
  }
  return out;
}

function groupOf(input: HTMLInputElement, root: ParentNode): HTMLInputElement[] {
  if (input.name) {
    const named = Array.from(root.querySelectorAll<HTMLInputElement>(`input[type='${input.type}']`)).filter(
      (x) => x.name === input.name && isVisible(x),
    );
    // Same-named checkboxes with the same value are separate boxes, one per entry
    // (Greenhouse's "Current role"), not one question's choices.
    if (input.type === "checkbox" && new Set(named.map((x) => x.value)).size < named.length) return [input];
    return named;
  }
  const box = input.closest("fieldset, [role='radiogroup'], [role='group']");
  return box ? Array.from(box.querySelectorAll<HTMLInputElement>(`input[type='${input.type}']`)) : [input];
}

/**
 * What a field asks for: the site's own naming first, then the label, read in
 * the light of its section ("Start Date" under Work Experience is the role's
 * start). Null for an open question.
 */
function keyOf(el: HTMLElement, label: string, site: Site | null): FieldKey | null {
  const named = site?.keyFor(el) ?? null;
  if (named) return named;
  if (el instanceof HTMLTextAreaElement || looksLikeEssay(label)) return null;
  return keyInSection(label, sectionOf(el)) ?? keyForLabel(label);
}

/**
 * Whether a field sits in a work or education section, from the nearest
 * heading above it: an h2 to h4, a legend, or an element styled as a section
 * title (SuccessFactors' "Work Experience" and "Education").
 */
export function sectionOf(el: HTMLElement): "work" | "education" | null {
  for (let node = el.parentElement; node && node !== el.ownerDocument.body; node = node.parentElement) {
    const heading = node.querySelector(
      ":scope > h2, :scope > h3, :scope > h4, :scope > legend, :scope > [class*='sectionTitle' i], :scope > [class*='section-title' i]",
    );
    if (!heading || heading.contains(el)) continue;
    const text = (heading.textContent ?? "").toLowerCase();
    if (/work experience|employment|work history|professional experience|^\s*experience/.test(text)) return "work";
    if (/education|academic|school/.test(text)) return "education";
    return null;
  }
  return null;
}

function comboboxHasValue(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement && el.value.trim()) return true;
  // react-select shows the chosen answer next to the input; Workday puts it in the button.
  const box = el.closest("[class*='select__control'], [class*='container']") ?? el.parentElement;
  const chosen = box?.querySelector("[class*='single-value'], [class*='singleValue']");
  if (chosen?.textContent?.trim()) return true;
  if (el instanceof HTMLButtonElement) {
    const shown = normalize(el.textContent ?? "");
    return shown !== "" && shown !== "select one" && !shown.startsWith("select");
  }
  return false;
}

export async function fillPage(
  root: ParentNode,
  profile: Profile,
  resume: File | null,
  site: Site | null,
  options: FillOptions = {},
): Promise<FillReport> {
  const pauseMs = options.pauseMs ?? 25;
  const report: FillReport = { filled: [], left: [], already: 0, skipped: [], failed: [], notAccepted: [], labels: new Map() };
  // A site may fill parts of the page itself first, such as Workday's work and
  // education entries. Fields it handled are skipped below.
  const handled = new Set<HTMLElement>();
  // Only the application itself, on a site that says where it is.
  root = site?.formRoot?.(root) ?? root;
  if (site?.before) await site.before(root, profile, resume, report, handled);
  // The n-th field asking for a work or education field gets the n-th entry.
  const seenKeys = new Map<FieldKey, number>();
  for (const c of candidates(root)) {
    if (handled.has(c.el) || (c.kind === "group" && c.inputs.some((x) => handled.has(x)))) continue;
    const target = c.kind === "control" || c.kind === "combobox" || c.kind === "datepicker" ? c.el : c.kind === "group" ? c.inputs[0] : c.buttons[0];
    const label = c.kind === "buttons" ? labelOf(c.el) : labelOf(target);
    // The name the report shows. A site may know a better one than the matching label:
    // Workday's dropdowns put their current answer in their aria-label, and the report never shows answers.
    const shownLabel = site?.reportLabel?.(target) || label;
    report.labels!.set(c.el, shownLabel);

    // A single checkbox is a consent or an agreement, so it's left for the person.
    // The one exception is a site's own "I currently work here" box.
    const isSingleBox = c.kind === "control" && c.el instanceof HTMLInputElement && c.el.type === "checkbox";
    const key = isSingleBox ? (site?.keyFor(target) === "workCurrent" ? "workCurrent" : null) : keyOf(target, label, site);
    // The n-th field asking for an entry's company gets the n-th role, counting
    // fields that are already answered, so row 2 still gets the second role.
    let index = 0;
    if (key && ENTRY_KEYS[key]) {
      index = seenKeys.get(key) ?? 0;
      seenKeys.set(key, index + 1);
    }

    // Already answered: leave it.
    const answered =
      c.kind === "control"
        ? hasValue(c.el) || (c.el instanceof HTMLInputElement && isSearchBox(c.el) && hasChosenItems(c.el))
        : c.kind === "group"
          ? c.inputs.some((x) => x.checked)
          : c.kind === "combobox"
            ? comboboxHasValue(c.el)
            : c.kind === "datepicker"
              ? datePickerValue(c.el) !== ""
              : c.buttons.some((b) => b.getAttribute("aria-pressed") === "true" || /active|selected/.test(b.className));
    if (answered) {
      report.already++;
      continue;
    }

    let outcome: Outcome = "left";
    const whole = key ? profileDate(key, profile, index) : null;
    if (key === "resume") {
      const ok = !!resume && c.kind === "control" && c.el instanceof HTMLInputElement && c.el.type === "file" && setFile(c.el, resume);
      outcome = ok ? "filled" : "left";
    } else if (key === "workCurrent" && isSingleBox) {
      const box = c.el as HTMLInputElement;
      if (profile.work[index]?.current) box.click();
      // Not current is answered by leaving it unticked; no entry leaves it for the person.
      outcome = profile.work[index] ? "filled" : "left";
    } else if (whole && (c.kind === "datepicker" || wantsFullDate(target))) {
      // A field that wants a day: resolve it (the 1st for a start, the month's last day for an end).
      const text = dateForField(whole.text, whole.role, patternFor(target));
      if (!text) {
        // "Present", or a date the profile doesn't have for an entry it does have.
        const entry = ENTRY_KEYS[key!] === "work" ? profile.work[index] : ENTRY_KEYS[key!] === "education" ? profile.education[index] : null;
        outcome = (entry && whole.role === "end") || OPTIONAL_KEYS.has(key!) ? "skipped" : "left";
      } else if (c.kind === "datepicker") {
        outcome = (await setDatePicker(c.el, text)) ? "filled" : "failed";
      } else {
        outcome = (await setTextChecked(target as HTMLInputElement, text)) ? "filled" : "failed";
      }
    } else if (key && c.kind !== "datepicker") {
      const value = valueFor(key, profile, index);
      if (!value && OPTIONAL_KEYS.has(key)) outcome = "skipped";
      else if (value) outcome = await answer(c, value);
      // A current role has no end date, so its end date fields aren't the person's to fill either.
      if (outcome === "left" && /^workEnd/.test(key) && profile.work[index]?.current) outcome = "skipped";
    }

    // A field with nothing to put in it for a missing entry (a second role the
    // profile doesn't have) is the person's, like any other. A field whose value
    // didn't stick is the person's too, and is also reported as failed.
    if (outcome === "filled") report.filled.push(c.el);
    else if (outcome === "skipped") report.skipped!.push(c.el);
    else {
      report.left.push(c.el);
      if (outcome === "failed") report.failed!.push(c.el);
      if (outcome === "notAccepted") report.notAccepted!.push(c.el);
    }
    if (outcome !== "skipped" && outcome !== "left" && pauseMs) await pause(pauseMs);
  }
  if (site?.after) await site.after(root, report);
  return report;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = "filled" | "left" | "skipped" | "failed" | "notAccepted";

/** A Workday widget's result as an outcome: taken, nothing to pick, or shown but not taken. */
function fromTaken(taken: Taken): Outcome {
  return taken === "accepted" ? "filled" : taken === "not_accepted" ? "notAccepted" : "left";
}

/** Answer one field. "failed" when a text field didn't keep the value even after a retry. */
async function answer(c: Candidate, value: string): Promise<Outcome> {
  const done = (ok: boolean): Outcome => (ok ? "filled" : "left");
  switch (c.kind) {
    case "group":
      return done(setChoice(c.inputs, value));
    case "buttons":
      return done(setButtonChoice(c.buttons, value));
    case "combobox":
      // A button that opens a list of options (Workday's State, Phone Device Type, Degree).
      if (c.el instanceof HTMLButtonElement && c.el.getAttribute("aria-haspopup") === "listbox") {
        return fromTaken(await pickFromListbox(c.el, value, aliasesFor(value)));
      }
      return done(await setCombobox(c.el, value));
    case "datepicker":
      return "left";
    case "control": {
      const el = c.el;
      if (el instanceof HTMLSelectElement) return done(setSelect(el, value));
      if (el instanceof HTMLInputElement && el.type === "file") return "left";
      // Workday's searchable lists are text inputs that open their options on Enter.
      if (el instanceof HTMLInputElement && isSearchBox(el)) {
        // Workday's newer search lists (data-uxi-widget-type="selectinput") are only answered by a chosen chip.
        if (el.getAttribute("data-uxi-widget-type") === "selectinput") return fromTaken(await pickFromSearch(el, value));
        return done(await setSearchBox(el, value));
      }
      if (el instanceof HTMLInputElement && el.type === "date") {
        // "05/18/2027" back to the date input's own "2027-05-18".
        const [m, d, y] = value.split("/");
        if (!y) return "left";
        return (await setTextChecked(el, `${y}-${m}-${d}`)) ? "filled" : "failed";
      }
      if (el instanceof HTMLInputElement && el.type === "month") {
        // "05/2027" back to the month input's own "2027-05".
        const [m, y] = value.split("/");
        return (await setTextChecked(el, `${y}-${m}`)) ? "filled" : "failed";
      }
      return (await setTextChecked(el as HTMLInputElement | HTMLTextAreaElement, value)) ? "filled" : "failed";
    }
  }
}

/** A Workday search box: a text input that lists matching options once you type and press Enter. */
export function isSearchBox(el: HTMLInputElement): boolean {
  return el.dataset.automationId === "searchBox" || el.getAttribute("data-uxi-widget-type") === "selectinput";
}

/** Whether a search box already shows chosen items next to it, as Workday does. */
export function hasChosenItems(input: HTMLElement): boolean {
  const box = input.closest("[data-automation-id^='formField-']") ?? input.parentElement;
  return Boolean(box?.querySelector("[data-automation-id='selectedItem']"));
}
