/**
 * Workday's My Experience page, which the general pass can't fill on its own:
 * work and education are lists of entries that start empty, each added with
 * the section's Add button, and skills are picked one at a time from a search
 * box. The widgets themselves (dates, search lists, dropdowns) and how to tell
 * whether Workday took a value are in workdayWidgets.ts.
 *
 * For each section this finds the entries already on the page (Workday adds
 * them itself when it reads an uploaded resume), matches them to the profile's
 * entries by company or school, fills the fields they're missing, and adds an
 * entry with Add for every profile entry that isn't there yet. It never
 * overwrites a field that has an answer, and never presses anything but Add.
 */
import { type EducationEntry, type Language, type Profile, type WorkEntry, monthParts, preferredName } from "../profile";
import { isVisible, setSearchBox, waitFor } from "./dom";
import { recordField } from "./debug";
import { click } from "./input";
import { live, remember } from "./live";
import type { FillReport } from "./engine";
import { bulletLines, withScheme } from "./format";
import { normalize } from "./keys";
import {
  type Taken,
  aliasesFor,
  buttonValue,
  chipsIn,
  dateSegments,
  fieldError,
  fieldOf,
  pickFromListbox,
  beginTrace,
  byName,
  matchSkill,
  pickFromSearch,
  segmentTaken,
  setWorkdayDate,
  setWorkdayText,
  workdayLabel,
} from "./workdayWidgets";

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement;

/** Buttons Autofill must never press, whatever a page calls its Add button. */
const NEVER = /save|continue|submit|review|next|apply|delete|remove|cancel|back/i;

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The field every entry of a section has, by the end of its id or its automation id. */
type Marker = string[];
const WORK: Marker = ["jobTitle"];
// Newer pages name it education-664--school; older ones schoolName.
const EDUCATION: Marker = ["school", "schoolName"];
const LANGUAGE: Marker = ["language"];
const WEBSITE: Marker = ["url"];

function markerSelector(marker: Marker): string {
  return marker.map((m) => `[id$='--${m}'], [data-automation-id='${m}']`).join(", ");
}

/**
 * The section whose heading matches ``title``: the heading's nearest container
 * with an Add button or an entry in it.
 */
export function sectionFor(root: ParentNode, title: RegExp, marker: Marker | string): HTMLElement | null {
  const markers = typeof marker === "string" ? [marker] : marker;
  const headings = Array.from(root.querySelectorAll<HTMLElement>("h2, h3, h4, [role='heading'], legend"));
  const heading = headings.find((h) => title.test(textOf(h)));
  if (!heading) return null;
  for (let node = heading.parentElement; node; node = node.parentElement) {
    if (addButton(node) || node.querySelector(markerSelector(markers))) return node;
    if (node.matches("[data-automation-id='applyFlowPage'], form, body")) break;
  }
  return null;
}

/** The section's Add (or Add Another) button. Only ever this one is pressed. */
export function addButton(section: HTMLElement): HTMLButtonElement | null {
  const buttons = Array.from(section.querySelectorAll<HTMLButtonElement>("button")).filter(isVisible);
  const own = buttons.find((b) => b.dataset.automationId === "add-button" && !NEVER.test(textOf(b)));
  if (own) return own;
  return (
    buttons.find((b) => {
      const words = `${b.dataset.automationId ?? ""} ${b.getAttribute("aria-label") ?? ""} ${textOf(b)}`;
      return /(^|\s)add(\s|$)|add another/i.test(words) && !NEVER.test(textOf(b));
    }) ?? null
  );
}

/** A field in an entry, by the end of its id (workExperience-4--jobTitle) or its automation id. */
function field(block: ParentNode, ...names: string[]): Field | null {
  for (const name of names) {
    const found = block.querySelector<Field>(`[id$='--${name}'], [data-automation-id='${name}']`);
    if (found) return found;
  }
  return null;
}

/**
 * The entries in a section: one block per occurrence of the field every entry
 * has, widened to the largest container that holds only that one (Workday's
 * "Work Experience 1" panel).
 */
function blocks(section: HTMLElement, marker: Marker): HTMLElement[] {
  const selector = markerSelector(marker);
  const markers = Array.from(section.querySelectorAll<HTMLElement>(selector));
  return markers.map((m) => {
    let block: HTMLElement = m;
    while (block.parentElement && block.parentElement !== section) {
      const parent = block.parentElement;
      if (parent.querySelectorAll(selector).length > 1) break;
      block = parent;
    }
    return block;
  });
}

/** What a field shows as its answer: a text box's value, a dropdown's choice, or a search list's chips. */
function valueOf(el: Field | null): string {
  if (!el) return "";
  if (el instanceof HTMLButtonElement) return buttonValue(el);
  if (el instanceof HTMLInputElement && isSearch(el)) return chipsIn(fieldOf(el) ?? el.parentElement).join(", ");
  return el.value.trim();
}

function isSearch(el: HTMLInputElement): boolean {
  return el.getAttribute("data-uxi-widget-type") === "selectinput" || el.dataset.automationId === "searchBox";
}

/**
 * Fields filled in one section, each with a way to fill it again, so the
 * section can be checked once it's done and a field Workday didn't take can
 * be retried before it's reported.
 */
class Filled {
  private items: { el: HTMLElement; again: () => Promise<Taken> }[] = [];
  constructor(
    private report: FillReport,
    private handled: Set<HTMLElement>,
  ) {}

  /** Record the outcome of filling ``el``. */
  record(el: HTMLElement, taken: Taken, again: () => Promise<Taken>, value: string | null = null): void {
    this.handled.add(el);
    if (taken !== "missing") {
      this.report.labels?.set(el, workdayLabel(el));
      recordField(el, value, taken);
    }
    if (taken === "accepted") {
      this.report.filled.push(el);
      this.items.push({ el, again });
    } else if (taken === "not_accepted") {
      this.items.push({ el, again });
      this.report.filled.push(el);
    } else if (taken === "no_match") {
      this.report.left.push(el);
    }
  }

  /**
   * After a section: any field it filled that Workday flags (an error under
   * it, aria-invalid, or a value it didn't take) is filled once more, then
   * reported as filled but not accepted.
   */
  async check(): Promise<void> {
    for (const item of this.items) {
      if (!this.rejected(live(item.el))) continue;
      beginTrace();
      const taken = await item.again();
      recordField(item.el, null, `retried: ${taken}`);
      if (taken === "accepted" && !this.rejected(live(item.el))) continue;
      this.report.filled = this.report.filled.filter((x) => x !== item.el);
      if (!this.report.left.includes(item.el)) this.report.left.push(item.el);
      (this.report.notAccepted ??= []).push(item.el);
    }
    this.items = [];
  }

  private rejected(el: HTMLElement): boolean {
    const wrapper = fieldOf(el) ?? el.closest<HTMLElement>("[data-automation-id='dateInputWrapper']");
    if (fieldError(wrapper)) return true;
    // A search list with typed text and no chip, or a date that shows digits Workday didn't take.
    if (el instanceof HTMLInputElement && isSearch(el)) return !chipsIn(fieldOf(el)).length;
    if (el.matches("[data-automation-id='dateInputWrapper']")) {
      const { month, year } = dateSegments(el);
      return [month, year].some((x) => x && x.value && !segmentTaken(x, x.value));
    }
    return false;
  }
}

/** Fill one field if it's empty, the way its kind of field needs. */
async function put(el: Field | null, value: string, done: Filled, aliases: string[] = []): Promise<void> {
  if (!el) return;
  if (!value || !isVisible(el) || valueOf(el)) {
    done.record(el, "missing", async () => "missing");
    return;
  }
  const fill = async (): Promise<Taken> => {
    const now = live(el);
    if (now instanceof HTMLButtonElement) return pickFromListbox(now, value, aliases);
    if (now instanceof HTMLInputElement && now.getAttribute("data-uxi-widget-type") === "selectinput") return pickFromSearch(now, value, byName(aliases));
    if (now instanceof HTMLInputElement && now.dataset.automationId === "searchBox") return (await setSearchBox(now, value)) ? "accepted" : "no_match";
    return setWorkdayText(now as HTMLInputElement | HTMLTextAreaElement, value);
  };
  remember(el);
  beginTrace();
  done.record(el, await fill(), fill, value);
}

/** A Workday date: month and year boxes, a year box alone, or one text field. */
async function putDate(block: ParentNode, name: string, value: string, done: Filled): Promise<void> {
  const box = block.querySelector<HTMLElement>(`[data-automation-id='formField-${name}'], [id$='--${name}']`);
  if (!box) return;
  const wrapper = box.matches("[data-automation-id='dateInputWrapper']")
    ? box
    : (box.querySelector<HTMLElement>("[data-automation-id='dateInputWrapper']") ?? box);
  const { month, year } = monthParts(value);
  const seg = dateSegments(wrapper);
  if (seg.month || seg.year) {
    for (const x of [seg.month, seg.year]) if (x) done.record(x, "missing", async () => "missing");
    // Answered only when Workday took it: digits typed into the box alone aren't an answer.
    const took = (x: HTMLInputElement | null) => !x || (!!x.value && segmentTaken(x, x.value));
    const already = !!seg.year?.value && took(seg.month) && took(seg.year);
    if (!year || already) return;
    const fill = () => setWorkdayDate(live(wrapper), month, year);
    remember(wrapper);
    beginTrace();
    done.record(wrapper, await fill(), fill, [seg.month ? month.padStart(2, "0") : "", year].filter(Boolean).join("/"));
    return;
  }
  const single = box instanceof HTMLInputElement ? box : box.querySelector<HTMLInputElement>("input");
  await put(single, month && year ? `${month}/${year}` : "", done);
}

/** Match profile entries to the blocks on the page by a key field, then pair the rest in order with empty blocks. */
function pair<T>(blocksOnPage: HTMLElement[], entries: T[], keyOfBlock: (b: HTMLElement) => string, keyOfEntry: (e: T) => string) {
  const pairs: [HTMLElement | null, T][] = [];
  const free = [...blocksOnPage];
  const unmatched: T[] = [];
  const same = (a: string, b: string) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));
  for (const entry of entries) {
    const k = normalize(keyOfEntry(entry));
    const i = free.findIndex((b) => same(normalize(keyOfBlock(b)), k));
    if (i >= 0) pairs.push([free.splice(i, 1)[0], entry]);
    else unmatched.push(entry);
  }
  // Empty blocks take the entries nobody matched; the rest need Add.
  for (const entry of unmatched) {
    const i = free.findIndex((b) => !keyOfBlock(b));
    pairs.push([i >= 0 ? free.splice(i, 1)[0] : null, entry]);
  }
  return pairs;
}

/** How long Workday gets to draw a new entry after Add. */
const ENTRY_TIMEOUT_MS = 4000;

/** Finds a section as it is on the page now: Add, and other answers, can redraw a whole section. */
type FindSection = () => HTMLElement | null;

/** Click Add and wait for the new entry to render. False when none appears. */
async function addEntry(find: FindSection, marker: Marker): Promise<boolean> {
  const section = find();
  if (!section) return false;
  const before = blocks(section, marker).length;
  const button = addButton(section);
  if (!button) return false;
  await click(button);
  const grown = await waitFor(() => {
    const now = find();
    return now && blocks(now, marker).length > before ? [now] : [];
  }, ENTRY_TIMEOUT_MS);
  if (grown.length) await new Promise((resolve) => setTimeout(resolve, 150));
  return grown.length > 0;
}

/**
 * Fill a section's entries. First Add is pressed until there's an entry for
 * every profile item, waiting for each one to render; then each entry is
 * filled. Adding first means nothing is filled in an entry that Workday
 * re-draws when the next one is added.
 */
async function fillEntries<T>(
  find: FindSection,
  marker: Marker,
  entries: T[],
  keyOfBlock: (b: HTMLElement) => string,
  keyOfEntry: (e: T) => string,
  fill: (block: HTMLElement, entry: T) => Promise<void>,
  done: Filled,
): Promise<void> {
  const first = find();
  if (!first || !entries.length) return;
  let missing = pair(blocks(first, marker), entries, keyOfBlock, keyOfEntry).filter(([b]) => !b).length;
  while (missing > 0 && (await addEntry(find, marker))) missing--;
  // Which entry on the page each profile item goes in, by position. Each entry is then found
  // afresh just before it's filled, since filling the one before can redraw the section.
  const now = find();
  if (!now) return;
  const onPage = blocks(now, marker);
  const plan = pair(onPage, entries, keyOfBlock, keyOfEntry).map(([b, entry]) => [b ? onPage.indexOf(b) : -1, entry] as const);
  for (const [index, entry] of plan) {
    const section = find();
    const block = index >= 0 && section ? blocks(section, marker)[index] : undefined;
    if (block) await fill(block, entry);
  }
  await done.check();
}

async function fillWork(find: FindSection, work: WorkEntry[], done: Filled, handled: Set<HTMLElement>, report: FillReport): Promise<void> {
  await fillEntries(
    find,
    WORK,
    work,
    (b) => valueOf(field(b, "companyName")) || valueOf(field(b, "jobTitle")),
    (w) => w.company || w.title,
    async (block, w) => {
      await put(field(block, "jobTitle"), w.title, done);
      await put(field(block, "companyName"), w.company, done);
      await put(field(block, "location"), w.location, done);
      const current = block.querySelector<HTMLInputElement>("[id$='--currentlyWorkHere'], [data-automation-id='currentlyWorkHere']");
      if (current) {
        handled.add(current);
        if (w.current && !live(current).checked) {
          await click(live(current));
          // Ticking it hides the To date and redraws the entry; let that finish before the next click.
          await new Promise((resolve) => setTimeout(resolve, 300));
          report.filled.push(current);
          report.labels?.set(current, workdayLabel(current));
        }
      }
      await putDate(block, "startDate", w.start, done);
      if (!w.current) await putDate(block, "endDate", w.end, done);
      else block.querySelectorAll<HTMLElement>("[id$='--endDate'] input, [data-automation-id='formField-endDate'] input").forEach((x) => handled.add(x));
      // A plain text box: each line gets a bullet so it doesn't read as one block.
      await put(field(block, "roleDescription", "description"), bulletLines(w.bullets), done);
    },
    done,
  );
}

async function fillEducation(find: FindSection, education: EducationEntry[], done: Filled): Promise<void> {
  await fillEntries(
    find,
    EDUCATION,
    education,
    (b) => valueOf(field(b, "school", "schoolName")) || textOf(b.querySelector("[data-automation-id='formField-schoolItem'] [data-automation-id='selectedItem']")),
    (e) => e.school,
    async (block, e) => {
      await put(field(block, "school", "schoolName"), e.school, done);
      await put(field(block, "degree"), e.degree, done, aliasesFor(e.degree));
      await put(field(block, "fieldOfStudy"), e.field, done);
      await put(field(block, "gradeAverage"), e.gpa, done);
      await putDate(block, "firstYearAttended", e.start, done);
      await putDate(block, "lastYearAttended", e.end, done);
    },
    done,
  );
}

async function fillLanguages(find: FindSection, languages: Language[], done: Filled, handled: Set<HTMLElement>, report: FillReport): Promise<void> {
  await fillEntries(
    find,
    LANGUAGE,
    languages,
    (b) => valueOf(field(b, "language")),
    (l) => l.language,
    async (block, l) => {
      await put(field(block, "language"), l.language, done);
      const fluent = block.querySelector<HTMLInputElement>("[id$='--native'], [data-automation-id='nativeLanguage'], input[type='checkbox']");
      if (fluent) {
        handled.add(fluent);
        if (/native|fluent/i.test(l.level) && !live(fluent).checked) {
          await click(live(fluent));
          report.filled.push(fluent);
          report.labels?.set(fluent, workdayLabel(fluent));
        }
      }
      // Reading, Speaking, Writing and the like: each its own dropdown.
      for (const level of Array.from(block.querySelectorAll<HTMLButtonElement>("button[aria-haspopup='listbox']"))) {
        if (level === field(block, "language")) continue;
        await put(level, l.level, done);
      }
    },
    done,
  );
}

async function fillWebsites(find: FindSection, urls: string[], done: Filled): Promise<void> {
  await fillEntries(
    find,
    WEBSITE,
    urls,
    (b) => valueOf(field(b, "url")),
    (u) => u,
    async (block, u) => put(field(block, "url"), u, done),
    done,
  );
}

/** Pick each skill the page doesn't show yet from the skills search list. */
async function fillSkills(root: ParentNode, skills: string[], report: FillReport, handled: Set<HTMLElement>): Promise<void> {
  const box = root.querySelector<HTMLElement>("[data-automation-id='formField-skills']");
  const input = box?.querySelector<HTMLInputElement>("input[data-uxi-widget-type='selectinput'], input[data-automation-id='searchBox'], input");
  if (!box || !input) return;
  handled.add(input);
  let added = 0;
  for (const skill of skills) {
    if (matchSkill(chipsIn(live(box)), skill) >= 0) continue;
    // Skills match by name only: "C" never picks C# or C++, "Django" never "Django Admin".
    beginTrace();
    const ok =
      isSearch(input) && input.getAttribute("data-uxi-widget-type") === "selectinput"
        ? (await pickFromSearch(live(input), skill, matchSkill)) === "accepted"
        : await setSearchBox(input, skill);
    recordField(input, skill, ok ? "accepted" : "no_match");
    if (ok) added++;
  }
  report.labels?.set(input, workdayLabel(input));
  if (added) report.filled.push(input);
  else if (!chipsIn(box).length && skills.length) report.left.push(input);
}

/** The person's links for Workday's Websites section, each with https:// when it had no scheme. LinkedIn has its own question. */
export function websitesFor(p: Profile): string[] {
  return [p.github, p.portfolio, ...p.websites].filter(Boolean).map(withScheme);
}

/** Everything on My Experience that comes in entries. Does nothing on Workday's other pages. */
export async function workdayEntries(root: ParentNode, profile: Profile, _resume: File | null, report: FillReport, handled: Set<HTMLElement>): Promise<void> {
  const done = new Filled(report, handled);
  await fillWork(() => sectionFor(root, /^work experience/i, WORK), profile.work, done, handled, report);
  await fillEducation(() => sectionFor(root, /^education/i, EDUCATION), profile.education, done);
  await fillLanguages(() => sectionFor(root, /^languages?/i, LANGUAGE), profile.languages, done, handled, report);
  await fillWebsites(() => sectionFor(root, /^websites?/i, WEBSITE), websitesFor(profile), done);
  await fillSkills(root, profile.skills, report, handled);
}

/**
 * My Information's "I have a preferred name" box. It's ticked only when the
 * profile has a preferred name; Workday then shows the preferred first and
 * last name fields, which the general pass fills. Without one the box is left
 * as it is and isn't counted as left for the person.
 */
export async function fillPreferredName(root: ParentNode, profile: Profile, report: FillReport, handled: Set<HTMLElement>): Promise<void> {
  const box = root.querySelector<HTMLInputElement>(
    "input[type='checkbox'][data-automation-id='preferredNameCheckbox'], input[type='checkbox'][id$='--preferredCheck'], input[type='checkbox'][id*='preferredName' i]",
  );
  if (!box) return;
  handled.add(box);
  if (!preferredName(profile) || box.checked) return;
  await click(box);
  report.filled.push(box);
  // Wait for Workday to show the preferred name fields.
  await waitFor(() =>
    Array.from(
      root.querySelectorAll<HTMLElement>("[data-automation-id*='preferredNameSection' i] input, [id*='preferredName--' i]"),
    ).filter((x) => x instanceof HTMLInputElement && x.type !== "checkbox" && isVisible(x)),
  );
}

/**
 * After the general pass: a field it filled that Workday now flags (an error
 * under it, or aria-invalid) is reported as filled but not accepted. The
 * widgets already retried their own fields once; this catches the rest, such
 * as a phone number in a format Workday refuses.
 */
export async function workdayAfter(_root: ParentNode, report: FillReport): Promise<void> {
  for (const el of [...report.filled]) {
    if (report.notAccepted?.includes(el) || !fieldError(fieldOf(el))) continue;
    report.filled = report.filled.filter((x) => x !== el);
    if (!report.left.includes(el)) report.left.push(el);
    (report.notAccepted ??= []).push(el);
  }
}

/** Workday's own step before the general pass: the preferred name, then My Experience's entries. */
export async function workdayBefore(root: ParentNode, profile: Profile, resume: File | null, report: FillReport, handled: Set<HTMLElement>): Promise<void> {
  await fillPreferredName(root, profile, report, handled);
  await workdayEntries(root, profile, resume, report, handled);
}
