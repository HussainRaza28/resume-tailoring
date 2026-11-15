/**
 * Reading and setting form fields the way a person would.
 *
 * Many job sites are React apps that ignore a value set straight on an input.
 * Setting it through the browser's own value setter and then firing "input" and
 * "change" makes the page see the change as typing.
 */
import { bestChoice } from "./keys";

export type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const SKIPPED_TYPES = new Set(["hidden", "submit", "button", "image", "reset", "search", "password"]);

export function isFillable(el: Element): el is Control {
  if (el instanceof HTMLInputElement) return !SKIPPED_TYPES.has(el.type);
  return el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
}

/**
 * Hidden, disabled or read-only fields are left alone. Layout isn't checked
 * (tests run without one), only the attributes and inline styles that hide things.
 * A file input is often hidden behind a styled button, so it counts as visible.
 */
export function isVisible(el: HTMLElement): boolean {
  if ((el as Control).disabled || ((el as HTMLInputElement).readOnly && !(el instanceof HTMLSelectElement))) return false;
  if (el instanceof HTMLInputElement && el.type === "file") return !el.closest("[hidden], [aria-hidden='true']");
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
    const style = node.style;
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  }
  return true;
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/[*✱]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The question a field asks, from (in order): aria-labelledby, aria-label, a
 * <label for>, a wrapping <label>, the legend of its fieldset (for radio
 * groups), a nearby element whose class says "label" or "title", the
 * placeholder, and last the field's name.
 */
export function labelOf(el: HTMLElement): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const joined = labelledBy
      .split(/\s+/)
      .map((id) => text(el.ownerDocument.getElementById(id)))
      .join(" ")
      .trim();
    if (joined) return joined;
  }
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();
  const isChoice = el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox");
  if (isChoice) {
    // A radio's own label is its choice; the question is the group's.
    const legend = el.closest("fieldset")?.querySelector("legend");
    if (legend) return text(legend);
    const group = el.closest("[role='radiogroup'], [role='group']");
    const groupLabel = group?.getAttribute("aria-label") ?? text(group?.getAttribute("aria-labelledby") ? el.ownerDocument.getElementById(group.getAttribute("aria-labelledby")!) : null);
    if (groupLabel) return groupLabel;
  } else {
    if (el.id) {
      const forLabel = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (text(forLabel)) return text(forLabel);
    }
    const wrapping = el.closest("label");
    if (wrapping) {
      const named = wrapping.querySelector("[class*='label'], [class*='title']");
      return text(named) || text(wrapping);
    }
  }
  // A container of the field with its own label element (Lever, Ashby, Workday).
  for (let node = el.parentElement; node && node !== el.ownerDocument.body; node = node.parentElement) {
    const named = node.querySelector(":scope > [class*='label'], :scope > [class*='title'], :scope > label, :scope > legend");
    if (named && !named.contains(el) && text(named)) return text(named);
    if (node.matches("form, fieldset, li, [class*='question'], [class*='field'], [data-automation-id*='formField']")) {
      const inside = node.querySelector("[class*='label'], [class*='title'], label, legend");
      if (inside && !inside.contains(el) && text(inside)) return text(inside);
    }
  }
  return (el as HTMLInputElement).placeholder?.trim() || el.getAttribute("name") || "";
}

/** The label of one choice in a radio group or checkbox list. */
export function choiceLabel(input: HTMLInputElement): string {
  if (input.id) {
    const forLabel = input.ownerDocument.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (text(forLabel)) return text(forLabel);
  }
  return text(input.closest("label")) || input.getAttribute("aria-label") || input.value;
}

function fire(el: Element, ...types: string[]): void {
  for (const type of types) el.dispatchEvent(new Event(type, { bubbles: true }));
}

/** Set a text field's value so React and plain pages both see it. */
export function setText(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  el.focus();
  if (setter) setter.call(el, value);
  else el.value = value;
  fire(el, "input", "change");
  el.blur();
}

/** Pick the option that best fits ``wanted``. False when none fits. */
export function setSelect(el: HTMLSelectElement, wanted: string): boolean {
  const options = Array.from(el.options);
  const index = bestChoice(
    options.map((o) => o.textContent ?? o.value),
    wanted,
  );
  if (index < 0) return false;
  el.value = options[index].value;
  fire(el, "input", "change");
  return true;
}

/** Click the radio (or checkbox) in a group that best fits ``wanted``. */
export function setChoice(inputs: HTMLInputElement[], wanted: string): boolean {
  const index = bestChoice(inputs.map(choiceLabel), wanted);
  if (index < 0) return false;
  const input = inputs[index];
  if (!input.checked) input.click();
  return input.checked;
}

/** Yes/No answered with two buttons instead of radios (Ashby does this). */
export function setButtonChoice(buttons: HTMLButtonElement[], wanted: string): boolean {
  const index = bestChoice(buttons.map((b) => text(b)), wanted);
  if (index < 0) return false;
  buttons[index].click();
  return true;
}

/**
 * Put a file in a file input, as if it had been chosen in the file dialog.
 * Browsers only allow this through a DataTransfer's file list.
 */
export function setFile(input: HTMLInputElement, file: File): boolean {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  fire(input, "input", "change");
  return (input.files?.length ?? 0) > 0;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for elements to appear, checking every 50 ms. Empty when they don't come in time. */
export async function waitFor<T extends Element>(find: () => T[], timeoutMs = 1500): Promise<T[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found.length || Date.now() > until) return found;
    await wait(50);
  }
}

function optionsFor(trigger: HTMLElement): HTMLElement[] {
  const doc = trigger.ownerDocument;
  const listId = trigger.getAttribute("aria-controls") || trigger.getAttribute("aria-owns");
  const list = listId ? doc.getElementById(listId) : null;
  const scope: ParentNode = list ?? doc;
  return Array.from(scope.querySelectorAll<HTMLElement>("[role='option']")).filter((o) => o.getAttribute("aria-disabled") !== "true");
}

/**
 * A searchable dropdown (role="combobox"): type the answer, wait for its list
 * of options, and click the best one. Used for Greenhouse's newer boards,
 * Ashby and Workday. False when no option fits.
 */
export async function setCombobox(input: HTMLElement, wanted: string): Promise<boolean> {
  input.focus();
  if (input instanceof HTMLInputElement) setText(input, wanted);
  else {
    input.click();
    fire(input, "mousedown");
  }
  input.focus();
  const options = await waitFor(() => optionsFor(input));
  const index = bestChoice(options.map((o) => text(o)), wanted);
  if (index < 0) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }
  options[index].click();
  return true;
}

/** Whether a field already holds an answer, so it isn't overwritten. */
export function hasValue(el: Control, group: HTMLInputElement[] = []): boolean {
  if (el instanceof HTMLSelectElement) return el.selectedIndex > 0 && el.value !== "";
  if (el instanceof HTMLInputElement && el.type === "file") return (el.files?.length ?? 0) > 0;
  if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) return [el, ...group].some((x) => x.checked);
  return el.value.trim() !== "";
}
