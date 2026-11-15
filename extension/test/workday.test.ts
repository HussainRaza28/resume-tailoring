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
import { type Profile, emptyProfile } from "../src/profile";

const PROFILE: Profile = {
  ...emptyProfile(),
  firstName: "Jordan",
  lastName: "Sample",
  email: "jordan.sample@example.com",
  phone: "555-010-0199",
  street: "100 Main St",
  city: "Springfield",
  state: "Illinois",
  postalCode: "62701",
  school: "State University",
  degree: "Bachelor's Degree",
  major: "Computer Science",
  gpa: "3.8",
  graduationDate: "2027-05",
  linkedin: "https://linkedin.com/in/jordan-sample",
  workAuthorized: "Yes",
  needsSponsorship: "No",
};
const RESUME = new File(["%PDF-1.7"], "Jordan_Sample_Resume.pdf", { type: "application/pdf" });

const OPTIONS: Record<string, string[]> = {
  countryDropdown: ["Canada", "India", "United States of America"],
  addressSection_countryRegion: ["Illinois", "Indiana", "Iowa"],
  "phone-device-type": ["Home", "Mobile", "Work"],
  degree: ["Associate's Degree", "Bachelor's Degree", "Master's Degree"],
  "primaryQuestionnaire--q1": ["Yes", "No"],
  "primaryQuestionnaire--q2": ["Yes", "No"],
  gender: ["Female", "Male", "I do not wish to answer"],
  hispanicOrLatino: ["Yes", "No", "I do not wish to answer"],
  ethnicityDropdown: ["Asian (United States of America)", "White (United States of America)", "I do not wish to answer"],
  veteranStatus: ["I am not a protected veteran", "I identify as one or more of the classifications of protected veteran", "I do not wish to self-identify"],
};

/** Make each dropdown button open its list of options, as Workday does. */
function dropdowns(): void {
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-haspopup='listbox']"))) {
    const options = OPTIONS[button.dataset.automationId ?? ""] ?? OPTIONS[button.id];
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-automation-widget='wd-popup']").forEach((p) => p.remove());
      const popup = document.createElement("div");
      popup.dataset.automationWidget = "wd-popup";
      popup.innerHTML = `<ul role="listbox">${options.map((o) => `<li role="option"><div>${o}</div></li>`).join("")}</ul>`;
      popup.querySelectorAll("li").forEach((li) =>
        li.addEventListener("click", () => {
          button.textContent = li.textContent;
          popup.remove();
        }),
      );
      document.body.append(popup);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll("[data-automation-widget='wd-popup']").forEach((p) => p.remove());
  });
}

function load(name: string): void {
  document.body.innerHTML = readFileSync(join(process.cwd(), "test", "fixtures", name), "utf8");
  dropdowns();
}
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const auto = (id: string) => $<HTMLInputElement>(`[data-automation-id='${id}']`);
const shown = (selector: string) => $(selector).textContent?.trim();

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("Workday", () => {
  it("is recognised on its job sites", () => {
    expect(siteFor("https://larkspur.wd5.myworkdayjobs.com/en-US/careers/job/Chicago/Intern_R1/apply")?.name).toBe("Workday");
    expect(siteFor("https://wd3.myworkdaysite.com/recruiting/larkspur/careers")?.name).toBe("Workday");
  });

  it("page 1, My Information", async () => {
    load("workday-1-my-information.html");
    const report = await fillPage(document, PROFILE, RESUME, workday);
    expect(shown("[data-automation-id='countryDropdown']")).toBe("United States of America");
    expect(auto("legalNameSection_firstName").value).toBe("Jordan");
    expect(auto("legalNameSection_lastName").value).toBe("Sample");
    expect(auto("addressSection_addressLine1").value).toBe("100 Main St");
    expect(auto("addressSection_city").value).toBe("Springfield");
    expect(shown("[data-automation-id='addressSection_countryRegion']")).toBe("Illinois");
    expect(auto("addressSection_postalCode").value).toBe("62701");
    expect(auto("email").value).toBe("jordan.sample@example.com");
    expect(auto("phone-number").value).toBe("555-010-0199");
    expect(report.filled).toHaveLength(9);
    // Left: how they heard, whether they worked there before, and the phone type.
    expect(report.left).toHaveLength(3);
    expect(document.querySelector("[data-automation-widget='wd-popup']")).toBeNull();
  });

  it("page 2, My Experience: education, resume and LinkedIn", async () => {
    load("workday-2-my-experience.html");
    const report = await fillPage(document, PROFILE, RESUME, workday);
    expect(auto("school").value).toBe("State University");
    expect(shown("[data-automation-id='degree']")).toBe("Bachelor's Degree");
    expect(auto("fieldOfStudy").value).toBe("Computer Science");
    expect(auto("gpa").value).toBe("3.8");
    expect(auto("file-upload-input-ref").files?.[0]?.name).toBe("Jordan_Sample_Resume.pdf");
    expect(auto("linkedinQuestion").value).toBe("https://linkedin.com/in/jordan-sample");
    expect(report.filled).toHaveLength(6);
    expect(report.left).toHaveLength(0);
  });

  it("page 3, Application Questions: Yes/No dropdowns, and the open question left", async () => {
    load("workday-3-application-questions.html");
    const report = await fillPage(document, PROFILE, RESUME, workday);
    expect(shown("#primaryQuestionnaire--q1")).toBe("Yes");
    expect(shown("#primaryQuestionnaire--q2")).toBe("No");
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

  it("page 5, Self Identify: name and the disability answer, the date left", async () => {
    load("workday-5-self-identify.html");
    const report = await fillPage(document, PROFILE, RESUME, workday);
    expect($<HTMLInputElement>("#selfIdentifiedDisabilityData--name").value).toBe("Jordan Sample");
    expect($<HTMLInputElement>("#d-decline").checked).toBe(true);
    expect($<HTMLInputElement>("#d-no").checked).toBe(false);
    expect(report.left.map((el) => el.id)).toEqual(["selfIdentifiedDisabilityData--dateSignedOn"]);
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
      expect(again.already, name).toBe(first.filled.length);
    }
  });
});
