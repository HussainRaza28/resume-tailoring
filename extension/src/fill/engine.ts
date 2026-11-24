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
  setSelect,
  setText,
} from "./dom";
import { ENTRY_KEYS, type FieldKey, OPTIONAL_KEYS, keyForLabel, looksLikeEssay, normalize, valueFor } from "./keys";
import type { Site } from "./sites";

export interface FillReport {
  filled: HTMLElement[];
  /** Fields left for the person, to highlight. A radio group is reported as its container. */
  left: HTMLElement[];
  /** Fields that already had an answer and were left as they were. */
  already: number;
}

type Candidate =
  | { kind: "control"; el: Control }
  | { kind: "group"; el: HTMLElement; inputs: HTMLInputElement[] }
  | { kind: "buttons"; el: HTMLElement; buttons: HTMLButtonElement[] }
  | { kind: "combobox"; el: HTMLElement };

const YES_NO = new Set(["yes", "no"]);

/** Every field on the page, once each, in page order. Radio groups and Yes/No button pairs count as one. */
export function candidates(root: ParentNode): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<Element>();
  const nodes = root.querySelectorAll<HTMLElement>("input, select, textarea, button, [role='combobox']");
  for (const el of Array.from(nodes)) {
    if (seen.has(el) || !isVisible(el)) continue;
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

/** What a field asks for: the site's own naming first, then the label. Null for an open question. */
function keyOf(el: HTMLElement, label: string, site: Site | null): FieldKey | null {
  const named = site?.keyFor(el) ?? null;
  if (named) return named;
  if (el instanceof HTMLTextAreaElement || looksLikeEssay(label)) return null;
  return keyForLabel(label);
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

export async function fillPage(root: ParentNode, profile: Profile, resume: File | null, site: Site | null): Promise<FillReport> {
  const report: FillReport = { filled: [], left: [], already: 0 };
  // A site may fill parts of the page itself first, such as Workday's work and
  // education entries. Fields it handled are skipped below.
  const handled = new Set<HTMLElement>();
  if (site?.before) await site.before(root, profile, resume, report, handled);
  // The n-th field asking for a work or education field gets the n-th entry.
  const seenKeys = new Map<FieldKey, number>();
  for (const c of candidates(root)) {
    if (handled.has(c.el) || (c.kind === "group" && c.inputs.some((x) => handled.has(x)))) continue;
    const target = c.kind === "control" || c.kind === "combobox" ? c.el : c.kind === "group" ? c.inputs[0] : c.buttons[0];
    const label = c.kind === "buttons" ? labelOf(c.el) : labelOf(target);

    // Already answered: leave it.
    const answered =
      c.kind === "control"
        ? hasValue(c.el) || (c.el instanceof HTMLInputElement && isSearchBox(c.el) && hasChosenItems(c.el))
        : c.kind === "group"
          ? c.inputs.some((x) => x.checked)
          : c.kind === "combobox"
            ? comboboxHasValue(c.el)
            : c.buttons.some((b) => b.getAttribute("aria-pressed") === "true" || /active|selected/.test(b.className));
    if (answered) {
      report.already++;
      continue;
    }

    // A single checkbox is a consent or an agreement, so it's left for the person.
    // The one exception is a site's own "I currently work here" box.
    const isSingleBox = c.kind === "control" && c.el instanceof HTMLInputElement && c.el.type === "checkbox";
    const key = isSingleBox ? (site?.keyFor(target) === "workCurrent" ? "workCurrent" : null) : keyOf(target, label, site);
    let done = false;
    let index = 0;
    if (key && ENTRY_KEYS[key]) {
      index = seenKeys.get(key) ?? 0;
      seenKeys.set(key, index + 1);
    }
    if (key === "resume") {
      done = !!resume && c.kind === "control" && c.el instanceof HTMLInputElement && c.el.type === "file" && setFile(c.el, resume);
    } else if (key === "workCurrent" && isSingleBox) {
      const box = c.el as HTMLInputElement;
      if (profile.work[index]?.current) box.click();
      // Not current is answered by leaving it unticked; no entry leaves it for the person.
      done = Boolean(profile.work[index]);
    } else if (key) {
      const value = valueFor(key, profile, index);
      // No middle name, no preferred name, no second address line: nothing to do here.
      if (!value && OPTIONAL_KEYS.has(key)) continue;
      if (value) done = await answer(c, value);
    }
    // A current role has no end date, so its end date fields aren't the person's to fill either.
    if (!done && key && /^workEnd/.test(key) && profile.work[index]?.current) continue;
    // A field with nothing to put in it for a missing entry (a second role the
    // profile doesn't have) is the person's, like any other.
    (done ? report.filled : report.left).push(c.el);
  }
  return report;
}

async function answer(c: Candidate, value: string): Promise<boolean> {
  switch (c.kind) {
    case "group":
      return setChoice(c.inputs, value);
    case "buttons":
      return setButtonChoice(c.buttons, value);
    case "combobox":
      return setCombobox(c.el, value);
    case "control": {
      const el = c.el;
      if (el instanceof HTMLSelectElement) return setSelect(el, value);
      if (el instanceof HTMLInputElement && el.type === "file") return false;
      // Workday's searchable lists are text inputs that open their options on Enter.
      if (el instanceof HTMLInputElement && isSearchBox(el)) return setSearchBox(el, value);
      if (el instanceof HTMLInputElement && el.type === "date") {
        // "05/18/2027" back to the date input's own "2027-05-18".
        const [m, d, y] = value.split("/");
        if (!y) return false;
        setText(el, `${y}-${m}-${d}`);
        return true;
      }
      if (el instanceof HTMLInputElement && el.type === "month") {
        // "05/2027" back to the month input's own "2027-05".
        const [m, y] = value.split("/");
        setText(el, `${y}-${m}`);
        return true;
      }
      setText(el, value);
      return true;
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
