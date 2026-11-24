/**
 * The profile page's form: the plain fields, drawn into sections, and editors
 * for the lists (work, education, languages) where entries can be added,
 * edited, moved and removed. The form is the page's state: readForm reads the
 * whole profile back out of it.
 *
 * Kept apart from the storage code so the tests can build the form, change it
 * and read the profile back without a browser extension around it.
 */
import {
  DECLINE,
  type Demographics,
  type EducationEntry,
  type Language,
  type Profile,
  type Questions,
  type WorkEntry,
  emptyEducation,
  emptyWork,
} from "./profile";

type TextKey = {
  [K in keyof Profile]: Profile[K] extends string ? K : never;
}[keyof Profile];
type ListKey = "skills" | "websites" | "facts";
type BoolKey = "hasPreferredName";

/** ``shownWith``: the field shows only while that checkbox is ticked, as Workday's preferred name does. */
type Field = (
  | { key: TextKey; label: string; type?: "text" | "email" | "tel" | "url" | "month"; wide?: boolean; placeholder?: string }
  | { key: TextKey; label: string; type: "select"; options: string[]; wide?: boolean }
  | { key: BoolKey; label: string; type: "check" }
  | { key: ListKey; label: string; type: "list"; placeholder?: string }
  | { key: keyof Questions; label: string; type: "question"; options?: string[]; placeholder?: string; input?: "date" }
  | { key: keyof Demographics; label: string; type: "demographic"; options: string[] }
  | { key: string; label: string; type: "heading" }
) & { shownWith?: BoolKey };

type Section =
  | { title: string; note?: string; fields: Field[] }
  | { title: string; note?: string; list: "work" | "education" | "languages" };

const YES_NO = ["", "Yes", "No"];
export const LEVELS = ["Native", "Fluent", "Advanced", "Intermediate", "Beginner"];

export const PHONE_TYPES = ["Mobile", "Home", "Work"];
export const CLEARANCES = ["None", "Public Trust", "Confidential", "Secret", "Top Secret", "Top Secret/SCI"];

export const SECTIONS: Section[] = [
  {
    title: "Legal name",
    note: "As on your ID. Workday's My Information page asks for these first.",
    fields: [
      { key: "firstName", label: "First name" },
      { key: "middleName", label: "Middle name" },
      { key: "lastName", label: "Last name" },
      { key: "preferred", label: "Preferred name", type: "heading" },
      { key: "hasPreferredName", label: "I have a preferred name", type: "check" },
      { key: "preferredFirstName", label: "Preferred first name", shownWith: "hasPreferredName" },
      { key: "preferredLastName", label: "Preferred last name", shownWith: "hasPreferredName" },
    ],
  },
  {
    title: "Contact",
    fields: [
      { key: "email", label: "Email", type: "email", wide: true },
      { key: "phoneType", label: "Phone device type", type: "select", options: PHONE_TYPES },
      { key: "phoneCountry", label: "Country phone code", placeholder: "United States (+1)" },
      { key: "phone", label: "Phone number", type: "tel" },
      { key: "phoneExtension", label: "Phone extension" },
    ],
  },
  {
    title: "Address",
    fields: [
      { key: "country", label: "Country", wide: true },
      { key: "street", label: "Address line 1", wide: true },
      { key: "street2", label: "Address line 2", wide: true, placeholder: "Apartment, suite, unit" },
      { key: "city", label: "City" },
      { key: "state", label: "State", placeholder: "e.g. Illinois" },
      { key: "postalCode", label: "Postal code" },
      { key: "county", label: "County" },
    ],
  },
  { title: "Work experience", note: "Most recent first. Workday gets one entry per role, with the bullets as the description.", list: "work" },
  { title: "Education", note: "Most recent first. The first school answers questions that ask about one.", list: "education" },
  {
    title: "Skills and links",
    fields: [
      { key: "skills", label: "Skills, one per line or separated by commas", type: "list", placeholder: "Python\nPostgreSQL\nDocker" },
      { key: "linkedin", label: "LinkedIn", type: "url" },
      { key: "github", label: "GitHub", type: "url" },
      { key: "portfolio", label: "Portfolio or website", type: "url" },
      { key: "websites", label: "Other links, one per line", type: "list", placeholder: "https://…" },
    ],
  },
  { title: "Languages", list: "languages" },
  {
    title: "Facts from Tailor",
    note: "Kept for reference when you answer questions yourself. Autofill doesn't type these anywhere.",
    fields: [{ key: "facts", label: "One fact per line", type: "list" }],
  },
  {
    title: "Work authorization",
    fields: [
      { key: "workAuthorized", label: "Authorized to work in the country?", type: "select", options: YES_NO },
      { key: "usCitizen", label: "U.S. citizen?", type: "select", options: YES_NO },
      { key: "sponsorshipNow", label: "Need visa sponsorship now?", type: "select", options: YES_NO },
      { key: "sponsorshipFuture", label: "Need visa sponsorship in the future?", type: "select", options: YES_NO },
      { key: "securityClearance", label: "Security clearance", type: "select", options: CLEARANCES },
    ],
  },
  {
    title: "Common questions",
    fields: [
      { key: "heardFrom", label: "How did you hear about us?", type: "question", placeholder: "Job board" },
      { key: "workedHereBefore", label: "Previously worked for this company?", type: "question", options: ["No", "Yes"] },
      { key: "over18", label: "18 or older?", type: "question", options: ["Yes", "No"] },
      { key: "willingToRelocate", label: "Willing to relocate?", type: "question", options: YES_NO },
      { key: "availableFrom", label: "Available from", type: "question", input: "date" },
      { key: "availableUntil", label: "Available until", type: "question", input: "date" },
    ],
  },
  {
    title: "Voluntary self-identification",
    fields: [
      { key: "gender", label: "Gender", type: "demographic", options: [DECLINE, "Female", "Male", "Non-binary"] },
      { key: "hispanicLatino", label: "Hispanic or Latino?", type: "demographic", options: [DECLINE, "Yes", "No"] },
      {
        key: "race",
        label: "Race",
        type: "demographic",
        options: [
          DECLINE,
          "American Indian or Alaska Native",
          "Asian",
          "Black or African American",
          "Native Hawaiian or Other Pacific Islander",
          "White",
          "Two or More Races",
        ],
      },
      { key: "veteran", label: "Veteran status", type: "demographic", options: [DECLINE, "I am not a protected veteran", "I am a protected veteran"] },
      { key: "disability", label: "Disability", type: "demographic", options: [DECLINE, "No, I do not have a disability", "Yes, I have a disability"] },
    ],
  },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function select(options: string[], value: string, blank = "Not set"): HTMLSelectElement {
  const s = el("select");
  for (const option of options) s.append(el("option", { value: option, textContent: option || blank }));
  s.value = options.includes(value) ? value : options[0];
  return s;
}

function labelled(label: string, control: HTMLElement, wide = false): HTMLLabelElement {
  const l = el("label", { className: wide ? "field wide" : "field" }, label, control);
  return l;
}

/** Split a list typed one per line or with commas. */
export function splitList(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/\n|,(?![^(]*\))/)
    .map((x) => x.trim())
    .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
}

function plainControl(field: Field, p: Profile): HTMLElement {
  switch (field.type) {
    case "select":
      return select(field.options, p[field.key]);
    case "demographic":
      return select(field.options, p.demographics[field.key]);
    case "question": {
      const value = p.questions[field.key];
      if (field.options) return select(field.options, value);
      return el("input", { type: field.input ?? "text", value, placeholder: field.placeholder ?? "" });
    }
    case "check":
      return el("input", { type: "checkbox", checked: p[field.key] });
    case "heading":
      return el("span");
    case "list":
      return el("textarea", { value: p[field.key].join("\n"), placeholder: field.placeholder ?? "", rows: 4 });
    default:
      return el("input", { type: field.type ?? "text", value: p[field.key], placeholder: field.placeholder ?? "" });
  }
}

// ── list editors ────────────────────────────────────────────

type Kind = "work" | "education" | "languages";

const ADD_LABEL: Record<Kind, string> = { work: "Add a role", education: "Add a school", languages: "Add a language" };

function headTitle(kind: Kind, entry: HTMLElement): string {
  const v = (name: string) => (entry.querySelector<HTMLInputElement>(`[data-field='${name}']`)?.value ?? "").trim();
  if (kind === "work") return [v("title"), v("company")].filter(Boolean).join(" · ") || "New role";
  if (kind === "education") return v("school") || "New school";
  return v("language") || "New language";
}

function entryShell(kind: Kind): { entry: HTMLDivElement; title: HTMLElement } {
  const entry = el("div", { className: "entry" });
  entry.dataset.kind = kind;
  const title = el("strong");
  const up = el("button", { type: "button", className: "icon", textContent: "↑", title: "Move up" });
  const down = el("button", { type: "button", className: "icon", textContent: "↓", title: "Move down" });
  const remove = el("button", { type: "button", className: "icon danger", textContent: "×", title: "Remove" });
  up.setAttribute("aria-label", "Move up");
  down.setAttribute("aria-label", "Move down");
  remove.setAttribute("aria-label", "Remove");
  up.addEventListener("click", () => {
    const prev = entry.previousElementSibling;
    if (prev?.classList.contains("entry")) prev.before(entry);
  });
  down.addEventListener("click", () => {
    const next = entry.nextElementSibling;
    if (next?.classList.contains("entry")) next.after(entry);
  });
  remove.addEventListener("click", () => entry.remove());
  entry.append(el("div", { className: "entry-head" }, title, up, down, remove));
  return { entry, title };
}

function input(name: string, value: string, type = "text", placeholder = ""): HTMLInputElement {
  const i = el("input", { type, value, placeholder });
  i.dataset.field = name;
  return i;
}

function workEntry(w: WorkEntry): HTMLDivElement {
  const { entry, title } = entryShell("work");
  const current = el("input", { type: "checkbox", checked: w.current });
  current.dataset.field = "current";
  const end = input("end", w.end, "month");
  const bullets = el("textarea", { value: w.bullets.join("\n"), rows: 4, placeholder: "One bullet per line" });
  bullets.dataset.field = "bullets";
  const sync = () => {
    end.disabled = current.checked;
    title.textContent = headTitle("work", entry);
  };
  entry.append(
    labelled("Job title", input("title", w.title)),
    labelled("Company", input("company", w.company)),
    labelled("Location", input("location", w.location, "text", "e.g. Chicago, IL")),
    el("label", { className: "check" }, current, "I currently work here"),
    labelled("Start", input("start", w.start, "month")),
    labelled("End", end),
    labelled("Description, one bullet per line", bullets, true),
  );
  entry.addEventListener("input", sync);
  entry.addEventListener("change", sync);
  sync();
  return entry;
}

function educationEntry(e: EducationEntry): HTMLDivElement {
  const { entry, title } = entryShell("education");
  const enrolled = el("input", { type: "checkbox", checked: e.current });
  enrolled.dataset.field = "current";
  const endLabel = labelled("Graduation (month and year)", input("end", e.end, "month"));
  entry.append(
    labelled("School", input("school", e.school), true),
    labelled("Degree", input("degree", e.degree, "text", "e.g. Bachelor of Science")),
    labelled("Field of study", input("field", e.field, "text", "e.g. Computer Science")),
    labelled("Minor", input("minor", e.minor)),
    labelled("GPA", input("gpa", e.gpa, "text", "e.g. 3.8")),
    el("label", { className: "check wide" }, enrolled, "I'm currently enrolled here"),
    labelled("Start", input("start", e.start, "month")),
    endLabel,
  );
  // Enrolled: the end date is the expected graduation.
  const sync = () => {
    title.textContent = headTitle("education", entry);
    endLabel.firstChild!.textContent = enrolled.checked ? "Expected graduation (month and year)" : "Graduation (month and year)";
  };
  entry.addEventListener("input", sync);
  entry.addEventListener("change", sync);
  sync();
  return entry;
}

function languageEntry(l: Language): HTMLDivElement {
  const { entry, title } = entryShell("languages");
  const level = select(LEVELS, l.level || "Fluent");
  level.dataset.field = "level";
  entry.append(labelled("Language", input("language", l.language)), labelled("Level", level));
  const sync = () => (title.textContent = headTitle("languages", entry));
  entry.addEventListener("input", sync);
  sync();
  return entry;
}

function listEditor(kind: Kind, p: Profile): HTMLElement {
  const list = el("div", { className: "entries" });
  list.dataset.list = kind;
  const make = (x: unknown) =>
    kind === "work" ? workEntry(x as WorkEntry) : kind === "education" ? educationEntry(x as EducationEntry) : languageEntry(x as Language);
  const items: unknown[] = kind === "work" ? p.work : kind === "education" ? p.education : p.languages;
  for (const item of items) list.append(make(item));
  const add = el("button", { type: "button", className: "sm entry-add", textContent: `+ ${ADD_LABEL[kind]}` });
  add.addEventListener("click", () => {
    const blank = kind === "work" ? emptyWork() : kind === "education" ? emptyEducation() : { language: "", level: "Fluent" };
    const entry = make(blank);
    add.before(entry);
    entry.querySelector<HTMLInputElement>("input")?.focus();
  });
  list.append(add);
  return list;
}

/** Draw the form's sections into ``form`` with the profile's values. */
export function renderForm(form: HTMLFormElement, profile: Profile): void {
  form.replaceChildren();
  for (const section of SECTIONS) {
    const fieldset = el("fieldset", {}, el("legend", { textContent: section.title }));
    if (section.note) fieldset.append(el("p", { className: "section-note", textContent: section.note }));
    if ("list" in section) {
      fieldset.append(listEditor(section.list, profile));
    } else {
      for (const field of section.fields) {
        if (field.type === "heading") {
          fieldset.append(el("h3", { className: "subhead", textContent: field.label }));
          continue;
        }
        const control = plainControl(field, profile);
        control.dataset.key = field.key;
        control.dataset.group =
          field.type === "demographic" ? "demographics" : field.type === "question" ? "questions" : field.type === "list" ? "list" : field.type === "check" ? "check" : "";
        if (field.type === "check") {
          fieldset.append(el("label", { className: "check wide" }, control, field.label));
          continue;
        }
        const wide = ("wide" in field && field.wide) || field.type === "list";
        const label = labelled(field.label, control, Boolean(wide));
        if (field.shownWith) label.dataset.shownWith = field.shownWith;
        fieldset.append(label);
      }
      // Fields that show only while their checkbox is ticked.
      const sync = () => {
        for (const label of Array.from(fieldset.querySelectorAll<HTMLElement>("[data-shown-with]"))) {
          const box = fieldset.querySelector<HTMLInputElement>(`[data-key='${label.dataset.shownWith}']`);
          label.hidden = !box?.checked;
        }
      };
      fieldset.addEventListener("change", sync);
      sync();
    }
    form.append(fieldset);
  }
}

function fieldValue(entry: Element, name: string): string {
  return (entry.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-field='${name}']`)?.value ?? "").trim();
}

/** Read the form back into a profile. Text is trimmed; blank entries are dropped. */
export function readForm(form: HTMLFormElement, base: Profile): Profile {
  const profile: Profile = { ...base, questions: { ...base.questions }, demographics: { ...base.demographics } };
  for (const node of Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-key]"))) {
    const key = node.dataset.key!;
    const value = node.value.trim();
    if (node.dataset.group === "check") profile[key as BoolKey] = (node as HTMLInputElement).checked;
    else if (node.dataset.group === "demographics") profile.demographics[key as keyof Demographics] = value || DECLINE;
    else if (node.dataset.group === "questions") profile.questions[key as keyof Questions] = value;
    else if (node.dataset.group === "list") profile[key as ListKey] = splitList(node.value);
    else (profile as unknown as Record<string, string>)[key] = value;
  }
  const entries = (kind: Kind) => Array.from(form.querySelectorAll(`.entry[data-kind='${kind}']`));
  profile.work = entries("work")
    .map((e) => {
      const current = e.querySelector<HTMLInputElement>("[data-field='current']")?.checked ?? false;
      return {
        title: fieldValue(e, "title"),
        company: fieldValue(e, "company"),
        location: fieldValue(e, "location"),
        current,
        start: fieldValue(e, "start"),
        end: current ? "" : fieldValue(e, "end"),
        bullets: fieldValue(e, "bullets")
          .split("\n")
          .map((b) => b.replace(/^[-•*]\s*/, "").trim())
          .filter(Boolean),
      };
    })
    .filter((w) => w.title || w.company);
  profile.education = entries("education")
    .map((e) => ({
      school: fieldValue(e, "school"),
      degree: fieldValue(e, "degree"),
      field: fieldValue(e, "field"),
      minor: fieldValue(e, "minor"),
      gpa: fieldValue(e, "gpa"),
      current: e.querySelector<HTMLInputElement>("[data-field='current']")?.checked ?? false,
      start: fieldValue(e, "start"),
      end: fieldValue(e, "end"),
    }))
    .filter((x) => x.school);
  profile.languages = entries("languages")
    .map((e) => ({ language: fieldValue(e, "language"), level: fieldValue(e, "level") }))
    .filter((x) => x.language);
  return profile;
}
