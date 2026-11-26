/**
 * Workday's own widgets, as they appear in saved application pages
 * (test-fixtures/workday_*.html), and how to tell whether Workday took a value.
 *
 * Dates. A date is a `dateInputWrapper` group of spinbutton inputs,
 * `dateSectionMonth-input` and `dateSectionYear-input` ("MM/YYYY" for work,
 * the year alone for education). Next to each input sits a
 * `dateSection*-display` element showing "MM" or "YYYY". Setting the input's
 * value and firing input/change shows the digits but leaves Workday's own
 * state empty, so Next says "The field From is required". Workday reads key
 * presses, so each digit is typed as keydown, input and keyup, then the field
 * is blurred. It took the value when the display shows it (and the input has
 * aria-valuenow), and the field has no error.
 *
 * Search lists. School or University, Field of Study, Skills, How Did You
 * Hear About Us and Country Phone Code are a `multiSelectContainer` with a
 * "Search" input (`data-uxi-widget-type="selectinput"`). Typed text alone
 * isn't an answer: an option has to be picked from the list Workday opens, and
 * then shows as a `selectedItem` chip in the field's `selectedItemList`, with
 * its text in a `promptOption`. The chips have role="option" too, so options
 * already on the page are never mistaken for the list that opens.
 *
 * Dropdowns. State, Phone Device Type, Country and Degree are a button with
 * aria-haspopup="listbox" showing "Select One". Clicking it opens a list of
 * role="option" elements; the chosen one's text replaces "Select One".
 *
 * The open lists aren't in the saved pages (Workday draws them in a popup
 * that was gone by the time the page was saved), so the list is found by role
 * and by being new: options that weren't on the page before the click.
 */
import { isVisible, labelOf, setText, waitFor } from "./dom";
import { bestChoice, normalize } from "./keys";

export type Taken = "accepted" | "not_accepted" | "no_match" | "missing";

/** How long Workday gets to open a list, and to show what was chosen. */
export const LIST_TIMEOUT_MS = 5000;
export const CHOSEN_TIMEOUT_MS = 2000;

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The `formField-*` wrapper of a field: where Workday shows its label and its error. */
export function fieldOf(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>("[data-automation-id^='formField-']");
}

/**
 * A field's name for the report: its label, after the entry it's in when it's
 * in one ("Work Experience 1: From"). Never its value.
 */
export function workdayLabel(el: HTMLElement): string {
  const field = fieldOf(el);
  const own = textOf(field?.querySelector("label, legend")).replace(/\*/g, "").trim();
  const panel = el.closest("[role='group'][aria-labelledby$='-panel']");
  const entry = textOf(panel?.querySelector("h5, h4, [role='heading']"));
  // Outside a formField (the SMS opt-in box), the general label rules apply.
  // The automation id names a field Workday draws no label text for ("phone-sms-opt-in").
  const named = (el.dataset.automationId ?? "").replace(/[-_]+/g, " ").trim();
  return [entry, own].filter(Boolean).join(": ") || labelOf(el) || (named && named[0].toUpperCase() + named.slice(1)) || el.id;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_TEXT = "[data-automation-id*='error' i], [role='alert'], [id^='error-' i], [class*='errorMessage' i]";

/**
 * What Workday says is wrong with a field: its error text, or "invalid" when
 * a control in it is aria-invalid="true" without a message. "" when nothing.
 */
export function fieldError(field: HTMLElement | null): string {
  if (!field) return "";
  const message = Array.from(field.querySelectorAll<HTMLElement>(ERROR_TEXT))
    .map((x) => textOf(x))
    .filter(Boolean)
    .join(" ");
  if (message) return message;
  return field.querySelector("[aria-invalid='true']") ? "invalid" : "";
}

/** Workday's error banner at the top or bottom of the page, if it shows one. */
export function bannerErrors(root: ParentNode): string[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>("[data-automation-id='errorBanner'], [data-automation-id='errorHeading'], [data-automation-id*='errorBanner' i]"),
  )
    .map((x) => textOf(x))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Typing the way Workday listens for it
// ---------------------------------------------------------------------------

function key(el: HTMLElement, type: "keydown" | "keypress" | "keyup", k: string): boolean {
  const code = /^\d$/.test(k) ? `Digit${k}` : k.length === 1 ? `Key${k.toUpperCase()}` : k;
  const keyCode = /^\d$/.test(k) ? 48 + Number(k) : k === "Enter" ? 13 : k === "Escape" ? 27 : k === "Backspace" ? 8 : k === "Tab" ? 9 : k.toUpperCase().charCodeAt(0);
  return el.dispatchEvent(new KeyboardEvent(type, { key: k, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true }));
}

/** Press a key that isn't text (Enter, Escape, Tab, ArrowDown). */
export function press(el: HTMLElement, k: string): void {
  key(el, "keydown", k);
  key(el, "keyup", k);
}

function setNative(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** Type text one character at a time: keydown, keypress, the value through the native setter, input, keyup. */
export function typeText(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  let typed = el.value;
  for (const ch of text) {
    const allowed = key(el, "keydown", ch);
    key(el, "keypress", ch);
    // A page that handles the key itself (preventDefault) sets the value on its own.
    if (allowed) {
      typed += ch;
      setNative(el, typed);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: ch, inputType: "insertText" }));
    }
    key(el, "keyup", ch);
  }
}

/** Empty a field the way a person would: select all, Backspace. */
export function clearTyped(el: HTMLInputElement | HTMLTextAreaElement): void {
  if (!el.value) return;
  key(el, "keydown", "Backspace");
  setNative(el, "");
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward" }));
  key(el, "keyup", "Backspace");
}

function blurField(el: HTMLElement): void {
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
  el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  if (el.ownerDocument.activeElement === el) el.blur();
}

/** A pointer press: mousedown, mouseup and click, as Workday's lists listen for. */
export function pointerClick(el: HTMLElement): void {
  for (const type of ["mousedown", "mouseup"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0 }));
  }
  el.click();
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** The month and year inputs of a Workday date, either of which may be missing. */
export function dateSegments(wrapper: ParentNode): { month: HTMLInputElement | null; year: HTMLInputElement | null } {
  return {
    month: wrapper.querySelector<HTMLInputElement>("[data-automation-id='dateSectionMonth-input']"),
    year: wrapper.querySelector<HTMLInputElement>("[data-automation-id='dateSectionYear-input']"),
  };
}

function shownIn(input: HTMLInputElement): string {
  const display = input.parentElement?.querySelector("[data-automation-id$='-display']");
  return textOf(display);
}

/** Whether Workday took ``value`` in a date segment: the display or aria-valuenow shows it. */
export function segmentTaken(input: HTMLInputElement, value: string): boolean {
  const n = Number(value);
  const now = input.getAttribute("aria-valuenow");
  const display = input.parentElement?.querySelector("[data-automation-id$='-display']");
  // Markup without a display or aria-valuenow has nothing else to show: the box's own value is all there is.
  if (!display && now === null) return input.value !== "" && Number(input.value) === n;
  const shown = shownIn(input);
  return (now !== null && Number(now) === n) || (/^\d+$/.test(shown) && Number(shown) === n);
}

function typeSegment(input: HTMLInputElement, value: string): void {
  // Workday focuses a segment when its section is clicked.
  const section = input.parentElement ?? input;
  pointerClick(section);
  input.focus();
  clearTyped(input);
  typeText(input, value);
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Fill a Workday date with a month and year, or a year alone, then check it
 * was taken. One retry: clear and type again. "missing" when the field has
 * no segment for a part the value gives.
 */
export async function setWorkdayDate(wrapper: HTMLElement, month: string, year: string): Promise<Taken> {
  const seg = dateSegments(wrapper);
  const parts: [HTMLInputElement, string][] = [];
  if (seg.month && month) parts.push([seg.month, month.padStart(2, "0")]);
  if (seg.year && year) parts.push([seg.year, year]);
  if (!parts.length) return "missing";
  const field = fieldOf(wrapper) ?? wrapper;
  const taken = () => parts.every(([input, v]) => segmentTaken(input, v)) && !fieldError(field);
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const [input, v] of parts) typeSegment(input, v);
    blurField(parts[parts.length - 1][0]);
    await settle(attempt ? 300 : 120);
    if (taken()) return "accepted";
  }
  return "not_accepted";
}

// ---------------------------------------------------------------------------
// Choosing from a list
// ---------------------------------------------------------------------------

/** Other names an answer goes by: "Mobile" finds "Home Cellular" or "Cell", "B.S." finds "Bachelors". */
export function aliasesFor(wanted: string): string[] {
  const w = normalize(wanted);
  if (/mobile|cell/.test(w)) return ["Mobile", "Cell", "Cellular", "Mobile Phone", "Cell Phone", "Personal Cell", "Personal Mobile"];
  if (/^(home|landline)/.test(w)) return ["Home", "Landline", "Home Phone"];
  if (/^(work|business|office)/.test(w)) return ["Work", "Business", "Office"];
  // Degrees: a profile says "B.S." or "Bachelor of Science", Workday's list says "Bachelors".
  if (/^(?:(?:b ?s|b ?a|b ?eng)\b|bachelor)/.test(w)) return ["Bachelors", "Bachelor's", "Bachelor", "Bachelor's Degree"];
  if (/^(?:(?:m ?s|m ?a|m ?eng|mba)\b|master)/.test(w)) return ["Masters", "Master's", "Master", "Master's Degree"];
  if (/^(ph ?d|doctor)/.test(w)) return ["Doctorate", "PhD", "Doctoral", "Doctor of Philosophy"];
  if (/^(?:(?:a ?s|a ?a)\b|associate)/.test(w)) return ["Associates", "Associate's", "Associate", "Associate's Degree"];
  if (/high school|ged|diploma/.test(w)) return ["High School", "High School Diploma", "GED"];
  return [];
}

/**
 * The option to pick for ``wanted``: exact, then one that starts with it, then
 * one that contains it, the shortest first within each ("Computer Science"
 * before "Computer Science and Engineering"). Each alias is tried the same way
 * after the answer itself. -1 when nothing fits.
 */
export function rankOption(options: string[], wanted: string, aliases: string[] = [], loose = false): number {
  const names = options.map((o) => normalize(o));
  // Yes, No and "decline to answer" have their own rules: "No" must not pick "None of the above"
  // and "I don't wish to answer" must find "I do not wish to self-identify".
  if (/^(yes|no)$/.test(normalize(wanted)) || /\b(wish|prefer|decline)\b/.test(normalize(wanted))) return bestChoice(options, wanted);
  for (const candidate of [wanted, ...aliases]) {
    const w = normalize(candidate);
    if (!w) continue;
    for (const fits of [(o: string) => o === w, (o: string) => o.startsWith(w), (o: string) => o.includes(w)]) {
      let best = -1;
      names.forEach((o, i) => {
        if (fits(o) && (best < 0 || o.length < names[best].length)) best = i;
      });
      if (best >= 0) return best;
    }
  }
  // A dropdown's fixed list may word the answer differently ("Male" for "Man"); a search list never guesses.
  return loose ? bestChoice(options, wanted) : -1;
}

/** An option's text: its own label, or the promptOption inside it. */
function optionText(o: HTMLElement): string {
  return o.getAttribute("data-automation-label") ?? textOf(o.querySelector("[data-automation-id='promptOption']") ?? o);
}

const OPTION = "[role='option'], [data-automation-id='promptOption']";

/** Options in the page that are part of a chosen-items list (chips), never part of an open list. */
function isChip(o: Element): boolean {
  return !!o.closest("[data-automation-id='selectedItemList'], [data-automation-id='selectedItem']");
}

/** Options that appeared since ``before``, as the open list, one element per option. */
function newOptions(doc: Document, before: Set<Element>, scope?: Element | null): HTMLElement[] {
  const found = Array.from((scope ?? doc).querySelectorAll<HTMLElement>(OPTION)).filter(
    (o) => !before.has(o) && !isChip(o) && o.getAttribute("aria-disabled") !== "true" && isVisible(o),
  );
  // A promptOption inside a role="option" is the same option.
  return found.filter((o) => !found.some((other) => other !== o && other.contains(o)));
}

/** The answers a search field shows as chips. */
export function chipsIn(field: ParentNode | null): string[] {
  if (!field) return [];
  return Array.from(field.querySelectorAll<HTMLElement>("[data-automation-id='selectedItem']")).map((chip) =>
    textOf(chip.querySelector("[data-automation-id='promptOption']") ?? chip),
  );
}

function chipFits(field: ParentNode | null, wanted: string): boolean {
  return rankOption(chipsIn(field), wanted) >= 0;
}

/**
 * Pick ``wanted`` in a Workday search list: type it, wait for the list, click
 * the best option, and check a chip for it appeared. When nothing fits, the
 * typed text is cleared so it isn't left in the field as if it were an answer.
 */
export async function pickFromSearch(input: HTMLInputElement, wanted: string, aliases: string[] = []): Promise<Taken> {
  const doc = input.ownerDocument;
  const field = fieldOf(input) ?? input.parentElement;
  if (chipFits(field, wanted)) return "accepted";
  const chipsBefore = chipsIn(field).length;
  const before = new Set(Array.from(doc.querySelectorAll(OPTION)));
  pointerClick(input);
  input.focus();
  clearTyped(input);
  typeText(input, wanted);
  press(input, "Enter");
  const options = await waitFor(() => newOptions(doc, before), LIST_TIMEOUT_MS);
  const index = rankOption(options.map(optionText), wanted, aliases);
  if (index < 0) {
    clearTyped(input);
    press(input, "Escape");
    blurField(input);
    return "no_match";
  }
  const chosen = optionText(options[index]);
  for (let attempt = 0; attempt < 2; attempt++) {
    // Workday listens on the option's radio or checkbox when it has one.
    const target = options[index].querySelector<HTMLElement>("input[type='radio'], input[type='checkbox']") ?? options[index];
    if (attempt === 0) pointerClick(target);
    else {
      // Second try: the keyboard. The list keeps focus on the first option after a search.
      options[index].focus?.();
      press(options[index], "Enter");
    }
    const chip = await waitFor(
      () => (chipsIn(field).length > chipsBefore && chipsIn(field).some((c) => normalize(c) === normalize(chosen)) ? [input] : []),
      CHOSEN_TIMEOUT_MS,
    );
    if (chip.length) {
      if (input.value) clearTyped(input);
      return "accepted";
    }
    if (!options[index].isConnected) break;
  }
  clearTyped(input);
  press(input, "Escape");
  return "not_accepted";
}

/** What a dropdown button shows as its answer, or "" for "Select One". */
export function buttonValue(button: HTMLElement): string {
  const shown = textOf(button);
  return /^select\b/i.test(shown) ? "" : shown;
}

/**
 * Pick ``wanted`` in a Workday dropdown: click the button, wait for its list,
 * click the best option, and check the button now shows it.
 */
export async function pickFromListbox(button: HTMLElement, wanted: string, aliases: string[] = []): Promise<Taken> {
  const doc = button.ownerDocument;
  if (buttonValue(button) && rankOption([buttonValue(button)], wanted, aliases, true) >= 0) return "accepted";
  const before = new Set(Array.from(doc.querySelectorAll(OPTION)));
  pointerClick(button);
  const options = await waitFor(() => {
    const controls = button.getAttribute("aria-controls");
    const list = controls ? doc.getElementById(controls) : null;
    return newOptions(doc, before, list);
  }, LIST_TIMEOUT_MS);
  const index = rankOption(options.map(optionText), wanted, aliases, true);
  if (index < 0) {
    press(button, "Escape");
    return options.length ? "no_match" : "not_accepted";
  }
  const chosen = optionText(options[index]);
  pointerClick(options[index]);
  const shown = await waitFor(() => (normalize(buttonValue(button)) === normalize(chosen) ? [button] : []), CHOSEN_TIMEOUT_MS);
  return shown.length ? "accepted" : "not_accepted";
}

/** A plain text box, set and checked: the value stays and the field has no error. */
export async function setWorkdayText(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<Taken> {
  for (let attempt = 0; attempt < 2; attempt++) {
    el.focus();
    setText(el, value);
    await settle(attempt ? 200 : 40);
    if (el.value === value && !fieldError(fieldOf(el))) return "accepted";
  }
  return "not_accepted";
}
