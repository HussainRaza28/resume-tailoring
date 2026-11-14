/**
 * The profile page's form: one list of fields, drawn into sections and read back.
 *
 * Kept apart from the storage code so the tests can build the form, change it
 * and read the profile back without a browser extension around it.
 */
import { DECLINE, type Demographics, type Profile } from "./profile";

type TextKey = Exclude<keyof Profile, "demographics">;

type Field =
  | { key: TextKey; label: string; type?: "text" | "email" | "tel" | "url" | "month"; wide?: boolean; placeholder?: string }
  | { key: TextKey; label: string; type: "select"; options: string[] }
  | { key: keyof Demographics; label: string; type: "demographic"; options: string[] };

const YES_NO = ["", "Yes", "No"];

export const SECTIONS: { title: string; fields: Field[] }[] = [
  {
    title: "Name and contact",
    fields: [
      { key: "firstName", label: "First name" },
      { key: "lastName", label: "Last name" },
      { key: "email", label: "Email", type: "email" },
      { key: "phone", label: "Phone", type: "tel" },
    ],
  },
  {
    title: "Address",
    fields: [
      { key: "street", label: "Street address", wide: true },
      { key: "city", label: "City" },
      { key: "state", label: "State", placeholder: "e.g. Illinois" },
      { key: "postalCode", label: "ZIP or postal code" },
      { key: "country", label: "Country" },
    ],
  },
  {
    title: "Education",
    fields: [
      { key: "school", label: "School", wide: true },
      { key: "degree", label: "Degree", placeholder: "e.g. Bachelor of Science" },
      { key: "major", label: "Major" },
      { key: "minor", label: "Minor" },
      { key: "gpa", label: "GPA", placeholder: "e.g. 3.8" },
      { key: "graduationDate", label: "Graduation date", type: "month" },
    ],
  },
  {
    title: "Links",
    fields: [
      { key: "linkedin", label: "LinkedIn", type: "url", wide: true },
      { key: "github", label: "GitHub", type: "url", wide: true },
      { key: "portfolio", label: "Portfolio or website", type: "url", wide: true },
    ],
  },
  {
    title: "Work",
    fields: [
      { key: "workAuthorized", label: "Authorized to work in the US?", type: "select", options: YES_NO },
      { key: "needsSponsorship", label: "Will you need visa sponsorship?", type: "select", options: YES_NO },
      { key: "startDate", label: "Available to start", placeholder: "e.g. May 2027", wide: true },
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

function control(field: Field, value: string): HTMLElement {
  const doc = document;
  if (field.type === "select" || field.type === "demographic") {
    const select = doc.createElement("select");
    for (const option of field.options) {
      const el = doc.createElement("option");
      el.value = option;
      el.textContent = option || "Not set";
      select.append(el);
    }
    select.value = field.options.includes(value) ? value : field.options[0];
    return select;
  }
  const input = doc.createElement("input");
  input.type = field.type ?? "text";
  input.value = value;
  if (field.placeholder) input.placeholder = field.placeholder;
  return input;
}

/** Draw the form's sections into ``form`` with the profile's values. */
export function renderForm(form: HTMLFormElement, profile: Profile): void {
  form.replaceChildren();
  for (const section of SECTIONS) {
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = section.title;
    fieldset.append(legend);
    for (const field of section.fields) {
      const label = document.createElement("label");
      label.className = "wide" in field && field.wide ? "field wide" : "field";
      label.append(field.label);
      const value = field.type === "demographic" ? profile.demographics[field.key] : profile[field.key];
      const el = control(field, value);
      el.dataset.key = field.key;
      el.dataset.group = field.type === "demographic" ? "demographics" : "";
      label.append(el);
      fieldset.append(label);
    }
    form.append(fieldset);
  }
}

/** Read the form back into a profile. Text is trimmed. */
export function readForm(form: HTMLFormElement, base: Profile): Profile {
  const profile: Profile = { ...base, demographics: { ...base.demographics } };
  for (const el of Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]"))) {
    const key = el.dataset.key!;
    const value = el.value.trim();
    if (el.dataset.group === "demographics") profile.demographics[key as keyof Demographics] = value || DECLINE;
    else (profile as unknown as Record<string, string>)[key] = value;
  }
  return profile;
}
