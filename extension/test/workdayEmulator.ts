/**
 * A stand-in for Workday's scripts, for tests on the saved pages in
 * test-fixtures/. Built from what those pages show; see workdayReal.test.ts.
 * Used by the jsdom tests and by the same pages loaded in Chromium.
 */
import { buttonValue, chipsIn, fieldError } from "../src/fill/workdayWidgets";

// ---------------------------------------------------------------------------
// Workday, as far as the saved pages show it
// ---------------------------------------------------------------------------

/** Dropdown buttons' lists, by the button's name. Neighbours that also match are there on purpose. */
const LISTS: Record<string, string[]> = {
  countryRegion: ["Vermont", "West Virginia", "Virginia", "Washington"],
  phoneType: ["Landline", "Home Cellular", "Work"],
  degree: ["High School Diploma", "Associates", "Bachelors", "Masters", "Doctorate"],
  country: ["Canada", "United States of America"],
};

/** Search lists' options, by the field's formField-* name. */
const SEARCH: Record<string, string[]> = {
  school: ["State University of Technology and Design", "State University-Main Campus", "Springfield Community College-East", "Springfield Community College"],
  fieldOfStudy: ["Computer Science and Engineering", "Computer Science", "Computer Engineering", "Mathematics and Statistics", "Mathematics"],
  skills: ["Python (Programming Language)", "Python", "PostgreSQL", "Docker"],
  source: ["Company Website", "Job Board", "LinkedIn"],
  countryPhoneCode: ["Canada (+1)", "United States of America (+1)"],
};

export interface Behaviour {
  /** Fields whose value Workday shows but refuses, by formField name (as for a value in the wrong format). */
  refuse?: string[];
}

const REQUIRED = (name: string) => `The field ${name} is required and must have a value.`;

function setError(field: HTMLElement, message: string | null): void {
  field.querySelectorAll("[data-automation-id='errorMessage']").forEach((x) => x.remove());
  field.querySelectorAll("input, button, textarea").forEach((x) => x.setAttribute("aria-invalid", message ? "true" : "false"));
  if (!message) return;
  const error = document.createElement("div");
  error.dataset.automationId = "errorMessage";
  error.setAttribute("role", "alert");
  error.textContent = message;
  field.append(error);
}

const fieldName = (el: Element) => el.closest<HTMLElement>("[data-automation-id^='formField-']")!.dataset.automationId!.slice("formField-".length);
const labelText = (field: HTMLElement) => (field.querySelector("label, legend")?.textContent ?? "").replace(/\*/g, "").trim();

function popup(texts: string[], onPick: (text: string) => void, asSearch: boolean): void {
  document.querySelectorAll("[data-test-popup]").forEach((p) => p.remove());
  const box = document.createElement("div");
  box.setAttribute("data-test-popup", "");
  box.dataset.automationId = "activeListContainer";
  box.innerHTML = asSearch
    ? `<div role="listbox">${texts.map((t) => `<div role="option" data-automation-label="${t}"><div data-automation-id="promptOption">${t}</div></div>`).join("")}</div>`
    : `<ul role="listbox">${texts.map((t) => `<li role="option"><div>${t}</div></li>`).join("")}</ul>`;
  box.querySelectorAll<HTMLElement>("[role='option']").forEach((o) =>
    o.addEventListener("click", () => {
      onPick(o.getAttribute("data-automation-label") ?? o.textContent!.trim());
      box.remove();
    }),
  );
  // Workday draws the list a moment after the click or the search.
  setTimeout(() => document.body.append(box), 60);
}

function addChip(field: HTMLElement, text: string): void {
  const container = field.querySelector("[data-automation-id='multiselectInputContainer']")!;
  let list = field.querySelector("[data-automation-id='selectedItemList']");
  if (!list) {
    const holder = document.createElement("div");
    holder.innerHTML = `<ul role="listbox" data-automation-id="selectedItemList" aria-label="items selected"></ul>`;
    container.append(holder);
    list = holder.firstElementChild!;
  }
  const li = document.createElement("li");
  li.setAttribute("role", "presentation");
  li.dataset.automationId = "menuItem";
  li.innerHTML = `<div role="option" data-automation-id="selectedItem" aria-label="${text}, press delete to clear value."><div data-automation-id="DELETE_charm" role="presentation"></div><p data-automation-id="promptOption">${text}</p></div>`;
  list.append(li);
  field.querySelector("[data-automation-id='promptAriaInstruction']")!.textContent = `${list.children.length} item selected, ${text}`;
}

const typed = new WeakMap<HTMLInputElement, string>();
let nextEntry = 900;

/** Remove the listeners ``installWorkday`` added. */
export function uninstallWorkday(): void {
  while (cleanups.length) cleanups.pop()!();
}
const cleanups: (() => void)[] = [];

export function installWorkday(behaviour: Behaviour = {}): void {
  const refused = new Set(behaviour.refuse ?? []);
  const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => {
    document.addEventListener(type, fn, true);
    cleanups.push(() => document.removeEventListener(type, fn, true));
  };

  on("click", (e) => {
    const target = e.target as HTMLElement;
    const button = target.closest?.("button");
    if (button?.getAttribute("aria-haspopup") === "listbox") {
      const name = button.getAttribute("name") ?? "";
      popup(LISTS[name] ?? [], (text) => {
        button.textContent = text;
        button.setAttribute("aria-label", `${labelText(button.closest("[data-automation-id^='formField-']")!)} ${text}`);
        const field = button.closest<HTMLElement>("[data-automation-id^='formField-']")!;
        setError(field, refused.has(name) ? "Select a valid value." : null);
      }, false);
      return;
    }
    if (button?.dataset.automationId === "add-button") {
      const section = button.closest<HTMLElement>("[role='group'][aria-labelledby$='-section']")!;
      const panels = Array.from(section.querySelectorAll<HTMLElement>(":scope > [role='group'][aria-labelledby$='-panel']"));
      const last = panels[panels.length - 1];
      setTimeout(() => {
        const copy = last.cloneNode(true) as HTMLElement;
        const old = (copy.querySelector("[data-fkit-id]")!.getAttribute("data-fkit-id") ?? "").split("--")[0];
        const fresh = old.replace(/-\d+$/, `-${nextEntry++}`);
        const n = panels.length + 1;
        let html = copy.outerHTML.replaceAll(old, fresh).replace(/-(\d+)-panel/g, `-${n}-panel`);
        html = html.replace(/(<h5[^>]*>)([^<]*?)\d+(<\/h5>)/, `$1$2${n}$3`);
        const holder = document.createElement("div");
        holder.innerHTML = html;
        const entry = holder.firstElementChild as HTMLElement;
        entry.querySelectorAll<HTMLInputElement>("input:not([type='checkbox']), textarea").forEach((x) => {
          x.value = "";
          x.setAttribute("value", "");
          x.removeAttribute("aria-valuenow");
        });
        entry.querySelectorAll("[data-automation-id='selectedItemList']").forEach((x) => x.parentElement!.remove());
        entry.querySelectorAll("button[aria-haspopup='listbox']").forEach((b) => (b.textContent = "Select One"));
        entry.querySelectorAll("[data-automation-id='dateSectionMonth-display']").forEach((x) => (x.textContent = "MM"));
        entry.querySelectorAll("[data-automation-id='dateSectionYear-display']").forEach((x) => (x.textContent = "YYYY"));
        entry.querySelectorAll<HTMLElement>("[data-automation-id^='formField-']").forEach((f) => setError(f, null));
        last.after(entry);
      }, 40);
      return;
    }
  });

  // Dates: digits are taken from key presses.
  on("keydown", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset?.automationId?.startsWith("dateSection")) {
      // Search lists open on Enter with what's typed.
      if (e.key === "Enter" && input.getAttribute?.("data-uxi-widget-type") === "selectinput") {
        const field = input.closest<HTMLElement>("[data-automation-id^='formField-']")!;
        const query = input.value.toLowerCase();
        popup((SEARCH[fieldName(input)] ?? []).filter((o) => o.toLowerCase().includes(query)), (text) => {
          addChip(field, text);
          input.value = "";
          setError(field, refused.has(fieldName(input)) ? "Select a valid value." : null);
        }, true);
      }
      return;
    }
    if (/^\d$/.test(e.key)) typed.set(input, (typed.get(input) ?? "") + e.key);
    if (e.key === "Backspace") typed.set(input, "");
  });
  on("focusout", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset?.automationId?.startsWith("dateSection")) return;
    const field = input.closest<HTMLElement>("[data-automation-id^='formField-']")!;
    const wrapper = input.closest<HTMLElement>("[data-automation-id='dateInputWrapper']")!;
    const commit = (x: HTMLInputElement) => {
      const keys = typed.get(x) ?? "";
      if (!x.value || keys !== x.value || refused.has(fieldName(x))) return false;
      const month = x.dataset.automationId === "dateSectionMonth-input";
      const shownValue = month ? x.value.padStart(2, "0") : x.value;
      x.parentElement!.querySelector("[data-automation-id$='-display']")!.textContent = shownValue;
      x.setAttribute("aria-valuenow", String(Number(x.value)));
      x.setAttribute("aria-valuetext", shownValue);
      return true;
    };
    const segments = Array.from(wrapper.querySelectorAll<HTMLInputElement>("input[data-automation-id$='-input']"));
    const ok = segments.map(commit).every(Boolean);
    const anyValue = segments.some((x) => x.value);
    setError(field, anyValue && !ok ? REQUIRED(labelText(field)) : null);
  });
  // "I currently work here" hides the To date.
  on("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (!box.id?.endsWith("--currentlyWorkHere")) return;
    const panel = box.closest("[data-fkit-id$='--null']")!;
    panel.querySelector<HTMLElement>("[data-automation-id='formField-endDate']")!.style.display = box.checked ? "none" : "";
  });
}

/** Press Next: every field Workday would refuse, by label. */
export function validate(): string[] {
  const errors: string[] = [];
  for (const field of Array.from(document.querySelectorAll<HTMLElement>("[data-automation-id^='formField-']"))) {
    if (field.style.display === "none" || field.closest("[style*='display: none']")) continue;
    // The résumé upload is the person's; Autofill attaches it only when given a file.
    if (field.querySelector("[data-automation-id='attachments-FileUpload']")) continue;
    const label = labelText(field);
    const required = !!field.querySelector("label abbr, legend abbr");
    const wrapper = field.querySelector("[data-automation-id='dateInputWrapper']");
    const search = field.querySelector<HTMLInputElement>("input[data-uxi-widget-type='selectinput']");
    const button = field.querySelector<HTMLButtonElement>("button[aria-haspopup='listbox']");
    const text = field.querySelector<HTMLInputElement | HTMLTextAreaElement>("input[type='text'], textarea");
    let error = fieldError(field) ? "error shown" : "";
    if (!error && wrapper) {
      const segs = Array.from(wrapper.querySelectorAll<HTMLInputElement>("input"));
      if (segs.some((x) => x.value && !x.hasAttribute("aria-valuenow"))) error = "date not committed";
      else if (required && segs.some((x) => !x.hasAttribute("aria-valuenow"))) error = "required";
    } else if (!error && search) {
      if (search.value) error = "typed text with no chosen item";
      else if (required && !chipsIn(field).length) error = "required";
    } else if (!error && button) {
      if (required && !buttonValue(button)) error = "required";
    } else if (!error && text) {
      if (required && !text.value.trim()) error = "required";
      else if (/url|linkedin/i.test(field.dataset.automationId!) && text.value && !/^https?:\/\//.test(text.value)) error = "not a URL";
    }
    if (error) errors.push(`${label}: ${error}`);
  }
  return errors;
}

