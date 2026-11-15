/**
 * Workday, page by page. Each page is filled when Autofill is pressed on it, and
 * the person moves on with Workday's own Save and Continue, which Autofill
 * never presses.
 *
 * Workday's dropdowns are buttons that open a list of options at the end of the
 * page. dropdowns() below does the same for the saved pages, with the options
 * a real form offers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fillPage } from "../src/fill/engine";
import { siteFor, workday } from "../src/fill/sites";
import { PROFILE } from "./sampleProfile";

const RESUME = new File(["%PDF-1.7"], "Jordan_Sample_Resume.pdf", { type: "application/pdf" });

const OPTIONS: Record<string, string[]> = {
  countryDropdown: ["Canada", "India", "United States of America"],
  addressSection_countryRegion: ["Illinois", "Indiana", "Iowa"],
  "phone-device-type": ["Home", "Mobile", "Work"],
  degree: ["Associate's Degree", "Bachelor's Degree", "Master's Degree"],
  language: ["English", "French", "Spanish"],
  "languageProficiency-0": ["Beginner", "Intermediate", "Advanced", "Fluent"],
  "languageProficiency-1": ["Beginner", "Intermediate", "Advanced", "Fluent"],
  "primaryQuestionnaire--q1": ["Yes", "No"],
  "primaryQuestionnaire--q2": ["Yes", "No"],
  "primaryQuestionnaire--q5": ["Yes", "No"],
  "primaryQuestionnaire--q6": ["Yes", "No"],
  gender: ["Female", "Male", "I do not wish to answer"],
  hispanicOrLatino: ["Yes", "No", "I do not wish to answer"],
  ethnicityDropdown: ["Asian (United States of America)", "White (United States of America)", "I do not wish to answer"],
  veteranStatus: ["I am not a protected veteran", "I identify as one or more of the classifications of protected veteran", "I do not wish to self-identify"],
};

/** What each search box lists after Enter, by its formField wrapper. */
const SEARCH: Record<string, string[]> = {
  sourcePrompt: ["Company Website", "Job Board", "Referral"],
  countryPhoneCode: ["Canada (+1)", "India (+91)", "United States of America (+1)"],
  skills: ["Docker", "Java", "PostgreSQL", "Python", "Python (Programming Language)"],
};

function popup(options: string[], choose: (text: string) => void, optionAttr = 'role="option"'): void {
  document.querySelectorAll("[data-automation-widget='wd-popup']").forEach((p) => p.remove());
  const box = document.createElement("div");
  box.dataset.automationWidget = "wd-popup";
  box.innerHTML = `<ul role="listbox">${options.map((o) => `<li ${optionAttr}><div>${o}</div></li>`).join("")}</ul>`;
  box.querySelectorAll("li").forEach((li) =>
    li.addEventListener("click", () => {
      choose(li.textContent ?? "");
      box.remove();
    }),
  );
  document.body.append(box);
}

/**
 * Workday's behaviour, for the saved pages: dropdown buttons open a list of
 * options, search boxes list matches after Enter and keep each pick as a
 * chosen item, and a section's Add button inserts a new entry from the page's
 * <template>. Wired once per page through event delegation, so entries added
 * later behave the same.
 */
const added: string[] = [];
function workdayBehaviour(): void {
  document.addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest("button");
    if (!button) return;
    if (button.getAttribute("aria-haspopup") === "listbox") {
      const options = OPTIONS[button.dataset.automationId ?? ""] ?? OPTIONS[button.id] ?? [];
      popup(options, (text) => (button.textContent = text));
      return;
    }
    const auto = button.dataset.automationId ?? "";
    if (auto === "Add" || auto === "Add Another") {
      const section = button.parentElement!;
      const name = section.dataset.automationId!;
      const template = document.querySelector<HTMLTemplateElement>(`template[data-entry='${name}']`)!;
      const list = section.querySelector(".entries")!;
      const n = list.children.length + 1;
      const holder = document.createElement("div");
      holder.innerHTML = template.innerHTML.replaceAll("{n}", String(n));
      // Workday adds the entry a moment after the click.
      setTimeout(() => list.append(...Array.from(holder.children)), 20);
      added.push(name);
    }
  });
  document.addEventListener("keydown", (e) => {
    const input = e.target as HTMLInputElement;
    if (e.key === "Escape") document.querySelectorAll("[data-automation-widget='wd-popup']").forEach((p) => p.remove());
    if (e.key !== "Enter" || input.dataset?.automationId !== "searchBox") return;
    const field = input.closest<HTMLElement>("[data-automation-id^='formField-']")!;
    const name = field.dataset.automationId!.slice("formField-".length);
    const typed = input.value.toLowerCase();
    const matches = (SEARCH[name] ?? []).filter((o) => o.toLowerCase().includes(typed));
    popup(matches, (text) => {
      const item = document.createElement("div");
      item.dataset.automationId = "selectedItem";
      item.textContent = text;
      field.querySelector("[data-automation-id='selectedItemList']")!.append(item);
      input.value = "";
    }, 'data-automation-id="promptOption"');
  });
}

function load(name: string): void {
  document.body.innerHTML = readFileSync(join(process.cwd(), "test", "fixtures", name), "utf8");
}
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const auto = (id: string) => $<HTMLInputElement>(`[data-automation-id='${id}']`);
const shown = (selector: string) => $(selector).textContent?.trim();
const chosen = (field: string) => Array.from(document.querySelectorAll(`[data-automation-id='formField-${field}'] [data-automation-id='selectedItem']`)).map((x) => x.textContent);

workdayBehaviour();

beforeEach(() => {
  document.body.innerHTML = "";
  added.length = 0;
});

describe("Workday", () => {
  it("is recognised on its job sites", () => {
    expect(siteFor("https://larkspur.wd5.myworkdayjobs.com/en-US/careers/job/Chicago/Intern_R1/apply")?.name).toBe("Workday");
    expect(siteFor("https://wd3.myworkdaysite.com/recruiting/larkspur/careers")?.name).toBe("Workday");
  });

  it("page 1, My Information: name, address, phone and the two questions", async () => {
    load("workday-1-my-information.html");
    const report = await fillPage(document, PROFILE, RESUME, workday);
    expect(chosen("sourcePrompt")).toEqual(["Job Board"]);
    expect($<HTMLInputElement>("input[name='candidateIsPreviousWorker'][value='false']").checked).toBe(true);
    expect(shown("[data-automation-id='countryDropdown']")).toBe("United States of America");
    expect(auto("legalNameSection_firstName").value).toBe("Jordan");
    expect(auto("legalNameSection_lastName").value).toBe("Sample");
    expect(auto("addressSection_addressLine1").value).toBe("100 Main St");
    expect(auto("addressSection_city").value).toBe("Springfield");
    expect(shown("[data-automation-id='addressSection_countryRegion']")).toBe("Illinois");
    expect(auto("addressSection_postalCode").value).toBe("62701");
    expect(auto("email").value).toBe("jordan.sample@example.com");
    expect(shown("[data-automation-id='phone-device-type']")).toBe("Mobile");
    expect(chosen("countryPhoneCode")).toEqual(["United States of America (+1)"]);
    expect(auto("phone-number").value).toBe("555-010-0199");
    expect(report.filled).toHaveLength(13);
    expect(report.left).toHaveLength(0);
    expect(document.querySelector("[data-automation-widget='wd-popup']")).toBeNull();
  });

  it("page 2, My Experience: adds each role and school, fills every field, picks the skills", async () => {
    load("workday-2-my-experience.html");
    const report = await fillPage(document, PROFILE, RESUME, workday);
    const v = (id: string) => $<HTMLInputElement>(`[id='${id}']`).value;
    const date = (id: string, part: "Month" | "Year") => $<HTMLInputElement>(`[id='${id}'] [data-automation-id='dateSection${part}-input']`).value;

    // Two roles, each added with Add and filled in order.
    expect(added.filter((x) => x === "workExperienceSection")).toHaveLength(2);
    expect(v("workExperience-1--jobTitle")).toBe("Software Engineering Intern");
    expect(v("workExperience-1--companyName")).toBe("Northwind Logistics");
    expect(v("workExperience-1--location")).toBe("Chicago, IL");
    expect($<HTMLInputElement>("[id='workExperience-1--currentlyWorkHere']").checked).toBe(false);
    expect([date("workExperience-1--startDate", "Month"), date("workExperience-1--startDate", "Year")]).toEqual(["06", "2025"]);
    expect([date("workExperience-1--endDate", "Month"), date("workExperience-1--endDate", "Year")]).toEqual(["08", "2025"]);
    expect(v("workExperience-1--roleDescription")).toBe(PROFILE.work[0].bullets.join("\n"));
    expect(v("workExperience-2--companyName")).toBe("Springfield Public Library");
    expect($<HTMLInputElement>("[id='workExperience-2--currentlyWorkHere']").checked).toBe(true);
    expect(date("workExperience-2--startDate", "Month")).toBe("01");
    expect(date("workExperience-2--endDate", "Month")).toBe("");

    // Workday had parsed State University already: its blanks are filled, no copy is added.
    expect(added.filter((x) => x === "educationSection")).toHaveLength(1);
    expect(document.querySelectorAll("[data-automation-id='schoolName']")).toHaveLength(2);
    expect(shown("[id='education-1--degree']")).toBe("Bachelor's Degree");
    expect(v("education-1--fieldOfStudy")).toBe("Computer Science");
    expect(v("education-1--gradeAverage")).toBe("3.8");
    expect(date("education-1--firstYearAttended", "Year")).toBe("2023");
    expect(date("education-1--lastYearAttended", "Year")).toBe("2027");
    expect(v("education-2--schoolName")).toBe("Springfield Community College");
    expect(shown("[id='education-2--degree']")).toBe("Associate's Degree");

    // Languages, skills, websites, the resume and LinkedIn.
    expect(shown("[id='language-1--language']")).toBe("Spanish");
    expect($<HTMLInputElement>("[id='language-1--native']").checked).toBe(true);
    expect(shown("[id='language-1--reading']")).toBe("Fluent");
    expect(chosen("skills")).toEqual(["Python", "PostgreSQL", "Docker"]);
    expect(v("webAddress-1--url")).toBe("https://github.com/jordan-sample");
    expect(v("webAddress-2--url")).toBe("https://jordan.example");
    expect(auto("file-upload-input-ref").files?.[0]?.name).toBe("Jordan_Sample_Resume.pdf");
    expect(auto("linkedinQuestion").value).toBe("https://linkedin.com/in/jordan-sample");
    expect(report.left).toHaveLength(0);
    expect(document.querySelector("[data-automation-widget='wd-popup']")).toBeNull();
  });

  it("page 2 again: entries already there are filled in place, never added twice", async () => {
    load("workday-2-my-experience.html");
    await fillPage(document, PROFILE, RESUME, workday);
    added.length = 0;
    const again = await fillPage(document, PROFILE, RESUME, workday);
    expect(added).toEqual([]);
    expect(again.filled).toHaveLength(0);
    expect(chosen("skills")).toEqual(["Python", "PostgreSQL", "Docker"]);
  });

  it("page 3, Application Questions: the yes/no questions answered, the open one left", async () => {
    load("workday-3-application-questions.html");
    const report = await fillPage(document, PROFILE, RESUME, workday);
    expect(shown("#primaryQuestionnaire--q1")).toBe("Yes");
    expect(shown("#primaryQuestionnaire--q2")).toBe("No");
    expect(shown("#primaryQuestionnaire--q5")).toBe("Yes");
    expect(shown("#primaryQuestionnaire--q6")).toBe("No");
    expect($<HTMLInputElement>("#primaryQuestionnaire--q3").value).toBe("05/2027");
    expect($<HTMLTextAreaElement>("#primaryQuestionnaire--q4").value).toBe("");
    expect(report.left.map((el) => el.id)).toEqual(["primaryQuestionnaire--q4"]);
  });

  it("page 4, Voluntary Disclosures: every answer declines, the terms box is left", async () => {
    load("workday-4-voluntary-disclosures.html");
    const report = await fillPage(document, PROFILE, RESUME, workday);
    expect(shown("[data-automation-id='gender']")).toBe("I do not wish to answer");
    expect(shown("[data-automation-id='hispanicOrLatino']")).toBe("I do not wish to answer");
    expect(shown("[data-automation-id='ethnicityDropdown']")).toBe("I do not wish to answer");
    expect(shown("[data-automation-id='veteranStatus']")).toBe("I do not wish to self-identify");
    expect(auto("agreementCheckbox").checked).toBe(false);
    expect(report.left.map((el) => el.dataset.automationId)).toEqual(["agreementCheckbox"]);
  });

  it("page 5, Self Identify: name, today's date and the disability answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 15) });
    load("workday-5-self-identify.html");
    const report = await fillPage(document, PROFILE, RESUME, workday);
    vi.useRealTimers();
    expect($<HTMLInputElement>("#selfIdentifiedDisabilityData--name").value).toBe("Jordan Sample");
    const part = (p: string) => $<HTMLInputElement>(`[data-automation-id='dateSection${p}-input']`).value;
    expect([part("Month"), part("Day"), part("Year")]).toEqual(["11", "15", "2026"]);
    expect($<HTMLInputElement>("#d-decline").checked).toBe(true);
    expect($<HTMLInputElement>("#d-no").checked).toBe(false);
    expect(report.left).toHaveLength(0);
  });

  it("never presses Save and Continue, and a second press changes nothing", async () => {
    for (const page of [1, 2, 3, 4, 5]) {
      const name = ["", "my-information", "my-experience", "application-questions", "voluntary-disclosures", "self-identify"][page];
      load(`workday-${page}-${name}.html`);
      const next = vi.fn();
      $("[data-automation-id='bottom-navigation-next-button']").addEventListener("click", next);
      const first = await fillPage(document, PROFILE, RESUME, workday);
      const again = await fillPage(document, PROFILE, RESUME, workday);
      expect(next, name).not.toHaveBeenCalled();
      expect(again.filled, name).toHaveLength(0);
      // My Experience fills its entries itself, so only the other pages count them as already answered.
      if (page !== 2) expect(again.already, name).toBe(first.filled.length);
      expect(first.filled.length, name).toBeGreaterThan(0);
    }
  });
});
