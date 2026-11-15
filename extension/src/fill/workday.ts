/**
 * Workday's My Experience page, which the general pass can't fill on its own:
 * work and education are lists of entries that start empty, each added with
 * the section's Add button, and skills are picked one at a time from a search
 * box.
 *
 * For each section this finds the entries already on the page (Workday adds
 * them itself when it reads an uploaded resume), matches them to the profile's
 * entries by company or school, fills the fields they're missing, and adds an
 * entry with Add for every profile entry that isn't there yet. It never
 * overwrites a field that has an answer, and never presses anything but Add.
 */
import { type EducationEntry, type Language, type Profile, type WorkEntry, monthParts } from "../profile";
import { hasValue, isVisible, setCombobox, setSearchBox, setText, waitFor } from "./dom";
import type { FillReport } from "./engine";
import { normalize } from "./keys";

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement;

/** Buttons Autofill must never press, whatever a page calls its Add button. */
const NEVER = /save|continue|submit|review|next|apply|delete|remove|cancel|back/i;

function textOf(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The section whose heading matches ``title``: the heading's nearest container
 * with an Add button or an entry in it.
 */
export function sectionFor(root: ParentNode, title: RegExp, marker: string): HTMLElement | null {
  const headings = Array.from(root.querySelectorAll<HTMLElement>("h2, h3, h4, [role='heading'], legend"));
  const heading = headings.find((h) => title.test(textOf(h)));
  if (!heading) return null;
  for (let node = heading.parentElement; node; node = node.parentElement) {
    if (addButton(node) || node.querySelector(`[id$='--${marker}'], [data-automation-id='${marker}']`)) return node;
    if (node.matches("[data-automation-id='applyFlowPage'], form, body")) break;
  }
  return null;
}

/** The section's Add (or Add Another) button. */
export function addButton(section: HTMLElement): HTMLButtonElement | null {
  const buttons = Array.from(section.querySelectorAll<HTMLButtonElement>("button")).filter(isVisible);
  return (
    buttons.find((b) => {
      const words = `${b.dataset.automationId ?? ""} ${b.getAttribute("aria-label") ?? ""} ${textOf(b)}`;
      return /(^|\s)add(\s|$)|add another/i.test(words) && !NEVER.test(textOf(b));
    }) ?? null
  );
}

/** A field in an entry, by the end of its id (workExperience-4--jobTitle) or its automation id. */
function field(block: ParentNode, name: string): Field | null {
  return block.querySelector<Field>(`[id$='--${name}'], [data-automation-id='${name}']`);
}

/**
 * The entries in a section: one block per occurrence of the field that every
 * entry has (jobTitle, schoolName, ...), widened to the largest container that
 * holds only that one.
 */
function blocks(section: HTMLElement, marker: string): HTMLElement[] {
  const markers = Array.from(section.querySelectorAll<HTMLElement>(`[id$='--${marker}'], [data-automation-id='${marker}']`));
  return markers.map((m) => {
    let block: HTMLElement = m;
    while (block.parentElement && block.parentElement !== section) {
      const parent = block.parentElement;
      const count = parent.querySelectorAll(`[id$='--${marker}'], [data-automation-id='${marker}']`).length;
      if (count > 1) break;
      block = parent;
    }
    return block;
  });
}

function valueOf(el: Field | null): string {
  if (!el) return "";
  if (el instanceof HTMLButtonElement) {
    const shown = normalize(textOf(el));
    return shown.startsWith("select") ? "" : textOf(el);
  }
  return el.value.trim();
}

/** Fill one field if it's empty. Records it as filled, and as handled either way. */
async function put(el: Field | null, value: string, report: FillReport, handled: Set<HTMLElement>): Promise<void> {
  if (!el) return;
  handled.add(el);
  if (!value || !isVisible(el)) return;
  if (el instanceof HTMLButtonElement) {
    if (valueOf(el)) return;
    if (await setCombobox(el, value)) report.filled.push(el);
    return;
  }
  if (hasValue(el)) return;
  if (el instanceof HTMLInputElement && el.dataset.automationId === "searchBox") {
    if (await setSearchBox(el, value)) report.filled.push(el);
    return;
  }
  setText(el, value);
  report.filled.push(el);
}

/** A Workday date: month and year boxes, a year box alone, or one text field. */
async function putDate(block: ParentNode, name: string, value: string, report: FillReport, handled: Set<HTMLElement>): Promise<void> {
  const box = block.querySelector<HTMLElement>(`[id$='--${name}'], [data-automation-id='formField-${name}']`);
  if (!box) return;
  const { month, year } = monthParts(value);
  const monthBox = box.querySelector<HTMLInputElement>("[data-automation-id='dateSectionMonth-input']");
  const yearBox = box.querySelector<HTMLInputElement>("[data-automation-id='dateSectionYear-input']");
  if (monthBox || yearBox) {
    await put(monthBox, month, report, handled);
    await put(yearBox, year, report, handled);
    return;
  }
  const single = box instanceof HTMLInputElement ? box : box.querySelector<HTMLInputElement>("input");
  await put(single, month && year ? `${month}/${year}` : "", report, handled);
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

/** Click Add and wait for the new entry. Null when none appears. */
async function addEntry(section: HTMLElement, marker: string): Promise<HTMLElement | null> {
  const before = blocks(section, marker).length;
  const button = addButton(section);
  if (!button) return null;
  button.click();
  const after = await waitFor(() => {
    const now = blocks(section, marker);
    return now.length > before ? now : [];
  }, 3000);
  return after.length > before ? after[after.length - 1] : null;
}

/** Fill each section's entries, adding entries where the profile has more. */
async function fillEntries<T>(
  section: HTMLElement | null,
  marker: string,
  entries: T[],
  keyOfBlock: (b: HTMLElement) => string,
  keyOfEntry: (e: T) => string,
  fill: (block: HTMLElement, entry: T) => Promise<void>,
): Promise<void> {
  if (!section || !entries.length) return;
  for (const [found, entry] of pair(blocks(section, marker), entries, keyOfBlock, keyOfEntry)) {
    const block = found ?? (await addEntry(section, marker));
    if (block) await fill(block, entry);
  }
}

async function fillWork(section: HTMLElement | null, work: WorkEntry[], report: FillReport, handled: Set<HTMLElement>): Promise<void> {
  await fillEntries(
    section,
    "jobTitle",
    work,
    (b) => valueOf(field(b, "companyName")) || valueOf(field(b, "jobTitle")),
    (w) => w.company || w.title,
    async (block, w) => {
      await put(field(block, "jobTitle"), w.title, report, handled);
      await put(field(block, "companyName"), w.company, report, handled);
      await put(field(block, "location"), w.location, report, handled);
      const current = block.querySelector<HTMLInputElement>("[id$='--currentlyWorkHere'], [data-automation-id='currentlyWorkHere']");
      if (current) {
        handled.add(current);
        if (w.current && !current.checked) {
          current.click();
          report.filled.push(current);
        }
      }
      await putDate(block, "startDate", w.start, report, handled);
      if (!w.current) await putDate(block, "endDate", w.end, report, handled);
      else block.querySelectorAll<HTMLElement>("[id$='--endDate'] input, [data-automation-id='formField-endDate'] input").forEach((x) => handled.add(x));
      await put(field(block, "roleDescription") ?? field(block, "description"), w.bullets.join("\n"), report, handled);
    },
  );
}

async function fillEducation(section: HTMLElement | null, education: EducationEntry[], report: FillReport, handled: Set<HTMLElement>): Promise<void> {
  await fillEntries(
    section,
    "schoolName",
    education,
    (b) => valueOf(field(b, "schoolName")) || textOf(b.querySelector("[data-automation-id='formField-schoolItem'] [data-automation-id='selectedItem']")),
    (e) => e.school,
    async (block, e) => {
      await put(field(block, "schoolName"), e.school, report, handled);
      await put(field(block, "degree"), e.degree, report, handled);
      await put(field(block, "fieldOfStudy"), e.field, report, handled);
      await put(field(block, "gradeAverage"), e.gpa, report, handled);
      await putDate(block, "firstYearAttended", e.start, report, handled);
      await putDate(block, "lastYearAttended", e.end, report, handled);
    },
  );
}

async function fillLanguages(section: HTMLElement | null, languages: Language[], report: FillReport, handled: Set<HTMLElement>): Promise<void> {
  await fillEntries(
    section,
    "language",
    languages,
    (b) => valueOf(field(b, "language")),
    (l) => l.language,
    async (block, l) => {
      await put(field(block, "language"), l.language, report, handled);
      const fluent = block.querySelector<HTMLInputElement>("[id$='--native'], [data-automation-id='nativeLanguage'], input[type='checkbox']");
      if (fluent) {
        handled.add(fluent);
        if (/native|fluent/i.test(l.level) && !fluent.checked) {
          fluent.click();
          report.filled.push(fluent);
        }
      }
      // Reading, Speaking, Writing and the like: each its own dropdown.
      for (const level of Array.from(block.querySelectorAll<HTMLButtonElement>("button[aria-haspopup='listbox']"))) {
        if (level === field(block, "language")) continue;
        await put(level, l.level, report, handled);
      }
    },
  );
}

async function fillWebsites(section: HTMLElement | null, urls: string[], report: FillReport, handled: Set<HTMLElement>): Promise<void> {
  await fillEntries(
    section,
    "url",
    urls,
    (b) => valueOf(field(b, "url")),
    (u) => u,
    async (block, u) => put(field(block, "url"), u, report, handled),
  );
}

/** Pick each skill the page doesn't show yet from the skills search box. */
async function fillSkills(root: ParentNode, skills: string[], report: FillReport, handled: Set<HTMLElement>): Promise<void> {
  const box = root.querySelector<HTMLElement>("[data-automation-id='formField-skills']");
  const input = box?.querySelector<HTMLInputElement>("input[data-automation-id='searchBox'], input");
  if (!box || !input) return;
  handled.add(input);
  const chosen = () => Array.from(box.querySelectorAll("[data-automation-id='selectedItem']")).map((x) => normalize(textOf(x)));
  let added = 0;
  for (const skill of skills) {
    if (chosen().includes(normalize(skill))) continue;
    if (await setSearchBox(input, skill)) added++;
  }
  if (added) report.filled.push(input);
  else if (!chosen().length && skills.length) report.left.push(input);
}

/** The person's links for Workday's Websites section; LinkedIn has its own question. */
export function websitesFor(p: Profile): string[] {
  return [p.github, p.portfolio, ...p.websites].filter(Boolean);
}

/** Everything on My Experience that comes in entries. Does nothing on Workday's other pages. */
export async function workdayEntries(root: ParentNode, profile: Profile, _resume: File | null, report: FillReport, handled: Set<HTMLElement>): Promise<void> {
  await fillWork(sectionFor(root, /^work experience/i, "jobTitle"), profile.work, report, handled);
  await fillEducation(sectionFor(root, /^education/i, "schoolName"), profile.education, report, handled);
  await fillLanguages(sectionFor(root, /^languages?/i, "language"), profile.languages, report, handled);
  await fillWebsites(sectionFor(root, /^websites?/i, "url"), websitesFor(profile), report, handled);
  await fillSkills(root, profile.skills, report, handled);
}
