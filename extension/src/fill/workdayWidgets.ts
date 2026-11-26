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
import { isVisible, labelOf, waitFor } from "./dom";
import { clearField, click, focusField, hasFocus, inputMode, leave, press, typeText } from "./input";
import { live, remember } from "./live";
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
// What happened while filling a field, for Debug mode
// ---------------------------------------------------------------------------

/** Notes about the field being filled right now: how it was typed, whether it kept focus, how many tries. */
export interface Trace {
  method: "trusted" | "synthetic";
  focusAfterTyping: boolean | null;
  attempts: number;
  steps: string[];
}

let trace: Trace = { method: "synthetic", focusAfterTyping: null, attempts: 0, steps: [] };

export function beginTrace(): Trace {
  trace = { method: inputMode().mode, focusAfterTyping: null, attempts: 0, steps: [] };
  return trace;
}

export function lastTrace(): Trace {
  return trace;
}

function step(name: string): void {
  if (trace.steps.length < 40) trace.steps.push(name);
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

/** Type a date segment as a person does: click it, delete what's there, press each digit. */
async function typeSegment(segment: HTMLInputElement, value: string): Promise<void> {
  const input = live(segment);
  // Workday focuses a segment when its section (the box around MM or YYYY) is clicked.
  await click(input.parentElement ?? input);
  if (!hasFocus(live(segment))) live(segment).focus();
  await clearField(live(segment));
  await typeText(live(segment), value, true);
  step(`typed ${value.length} digits`);
}

/**
 * Fill a Workday date with a month and year, or a year alone, then check it
 * was taken. One retry: clear and type again. "missing" when the field has
 * no segment for a part the value gives.
 */
export async function setWorkdayDate(wrapper: HTMLElement, month: string, year: string): Promise<Taken> {
  remember(wrapper);
  const seg = dateSegments(wrapper);
  const parts: [HTMLInputElement, string][] = [];
  if (seg.month && month) parts.push([seg.month, month.padStart(2, "0")]);
  if (seg.year && year) parts.push([seg.year, year]);
  if (!parts.length) return "missing";
  for (const [input] of parts) remember(input);
  const taken = () => parts.every(([input, v]) => segmentTaken(live(input), v)) && !fieldError(fieldOf(live(wrapper)) ?? live(wrapper));
  for (let attempt = 0; attempt < 2; attempt++) {
    trace.attempts++;
    for (const [input, v] of parts) await typeSegment(input, v);
    trace.focusAfterTyping = hasFocus(live(parts[parts.length - 1][0]));
    leave(live(parts[parts.length - 1][0]));
    await settle(attempt ? 400 : 200);
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

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Words Workday adds to a skill's name that don't change which skill it is. */
const SKILL_QUALIFIERS = /\b(programming language|programming|language|framework|library|software|platform)\b/g;

/**
 * A skill's name for comparing: lower case, parenthetical qualifiers dropped
 * ("Python (Programming Language)" is "python"), generic words dropped ("R
 * Programming" is "r"), other punctuation removed. "+", "#" and "." stay,
 * because C, C++ and C# are different skills, as are Node.js and Node.
 */
export function skillKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9+#.\s]/g, " ")
    .replace(SKILL_QUALIFIERS, " ")
    .replace(/(^|\s)\.+|\.+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Skills that go by more than one name. Each group is one skill. */
const SKILL_ALIASES: string[][] = [
  ["javascript", "js", "ecmascript"],
  ["typescript", "ts"],
  ["go", "golang"],
  ["postgresql", "postgres"],
  ["c#", "csharp", "c sharp"],
  ["c++", "cpp"],
  ["react", "react.js", "reactjs"],
  ["node.js", "nodejs", "node"],
  ["vue", "vue.js", "vuejs"],
  ["next.js", "nextjs"],
  ["aws", "amazon web services"],
  ["gcp", "google cloud platform", "google cloud"],
  ["azure", "microsoft azure"],
  ["kubernetes", "k8s"],
  ["machine learning", "ml"],
  ["artificial intelligence", "ai"],
  ["html", "html5"],
  ["css", "css3"],
  ["objective-c", "objective c"],
  ["scikit-learn", "sklearn", "scikit learn"],
  ["tensorflow", "tensor flow"],
  ["pytorch", "torch"],
  ["github actions", "github action"],
  ["ci cd", "ci/cd", "continuous integration"],
  ["shell", "bash", "shell scripting"],
];

function aliasGroup(key: string): string[] {
  const group = SKILL_ALIASES.find((g) => g.map(skillKey).includes(key));
  return group ? group.map(skillKey) : [key];
}

/**
 * The option that is ``wanted``, as a skill: the same name once qualifiers are
 * dropped, else a known other name for it. Never a longer or different skill:
 * "C" doesn't pick C# or C++, "Django" doesn't pick "Django Admin", "SQL"
 * doesn't pick "Interactive SQL". -1 when no option is that skill.
 */
export function matchSkill(options: string[], wanted: string): number {
  const keys = options.map(skillKey);
  const own = skillKey(wanted);
  if (!own) return -1;
  // The shortest exact name first: "Python" before "Python (Programming Language)".
  const exact = keys.map((k, i) => [k, i] as const).filter(([k]) => k === own).sort((a, b) => options[a[1]].length - options[b[1]].length);
  if (exact.length) return exact[0][1];
  const others = aliasGroup(own).filter((k) => k !== own);
  for (const other of others) {
    const i = keys.indexOf(other);
    if (i >= 0) return i;
  }
  return -1;
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

/** How to choose among a list's options: ``rankOption`` with aliases, or ``matchSkill`` for skills. */
export type Matcher = (options: string[], wanted: string) => number;

export const byName = (aliases: string[] = []): Matcher => (options, wanted) => rankOption(options, wanted, aliases);

/**
 * Pick ``wanted`` in a Workday search list: click the box, type it, wait for
 * the list, click the matching option, and check a chip for it appeared. When
 * nothing matches, the typed text is cleared so it isn't left in the field as
 * if it were an answer.
 */
export async function pickFromSearch(input: HTMLInputElement, wanted: string, match: Matcher = byName()): Promise<Taken> {
  remember(input);
  const doc = input.ownerDocument;
  const fieldNow = () => fieldOf(live(input)) ?? live(input).parentElement;
  const chips = () => chipsIn(fieldNow());
  if (match(chips(), wanted) >= 0) return "accepted";
  const chipsBefore = chips().length;
  for (let attempt = 0; attempt < 2; attempt++) {
    trace.attempts++;
    const before = new Set(Array.from(doc.querySelectorAll(OPTION)));
    await focusField(live(input));
    await clearField(live(input));
    await typeText(live(input), wanted);
    trace.focusAfterTyping = hasFocus(live(input));
    await press(live(input), "Enter");
    step("searched");
    const options = await waitFor(() => newOptions(doc, before), LIST_TIMEOUT_MS);
    const index = match(options.map(optionText), wanted);
    if (index < 0) {
      step(options.length ? `no match in ${options.length} options` : "no options");
      await clearField(live(input));
      await press(live(input), "Escape");
      leave(live(input));
      return "no_match";
    }
    const chosen = optionText(options[index]);
    // Workday listens on the option's radio or checkbox when it has one.
    const target = options[index].querySelector<HTMLElement>("input[type='radio'], input[type='checkbox']") ?? options[index];
    await click(target);
    step("clicked option");
    const chip = await waitFor(
      () => (chips().length > chipsBefore && chips().some((c) => normalize(c) === normalize(chosen)) ? [live(input)] : []),
      CHOSEN_TIMEOUT_MS,
    );
    if (chip.length) {
      if (live(input).value) await clearField(live(input));
      await press(live(input), "Escape");
      leave(live(input));
      return "accepted";
    }
    step("no chip");
  }
  await clearField(live(input));
  await press(live(input), "Escape");
  leave(live(input));
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
  remember(button);
  const doc = button.ownerDocument;
  const shownNow = () => buttonValue(live(button));
  if (shownNow() && rankOption([shownNow()], wanted, aliases, true) >= 0) return "accepted";
  for (let attempt = 0; attempt < 2; attempt++) {
    trace.attempts++;
    const before = new Set(Array.from(doc.querySelectorAll(OPTION)));
    await click(live(button));
    step("opened");
    const options = await waitFor(() => {
      const controls = live(button).getAttribute("aria-controls");
      const list = controls ? doc.getElementById(controls) : null;
      return newOptions(doc, before, list);
    }, LIST_TIMEOUT_MS);
    const index = rankOption(options.map(optionText), wanted, aliases, true);
    if (index < 0) {
      step(options.length ? `no match in ${options.length} options` : "no options");
      await press(live(button), "Escape");
      if (options.length) return "no_match";
      continue;
    }
    const chosen = optionText(options[index]);
    await click(options[index]);
    step("clicked option");
    const shown = await waitFor(() => (normalize(shownNow()) === normalize(chosen) ? [live(button)] : []), CHOSEN_TIMEOUT_MS);
    if (shown.length) return "accepted";
  }
  return "not_accepted";
}

/**
 * A plain text box: click into it, replace what's there with the value, leave
 * it, and check (on the element as it is now) that the value stayed and the
 * field shows no error. One retry.
 */
export async function setWorkdayText(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<Taken> {
  remember(el);
  for (let attempt = 0; attempt < 2; attempt++) {
    trace.attempts++;
    await focusField(live(el));
    await clearField(live(el));
    await typeText(live(el), value);
    trace.focusAfterTyping = hasFocus(live(el));
    leave(live(el));
    await settle(attempt ? 300 : 120);
    const now = live(el);
    if (now.value === value && !fieldError(fieldOf(now))) return "accepted";
    step(now.value === value ? "error shown" : now.value ? "different value" : "empty after typing");
  }
  return "not_accepted";
}
