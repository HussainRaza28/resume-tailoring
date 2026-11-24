/**
 * The filler, run on saved forms from each site. See test/fixtures: each sample
 * says where its structure comes from.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fillPage } from "../src/fill/engine";
import { bestChoice, keyForLabel, looksLikeEssay } from "../src/fill/keys";
import { ashby, greenhouse, lever, siteFor } from "../src/fill/sites";
import { DECLINE } from "../src/profile";
import { PROFILE } from "./sampleProfile";

const RESUME = new File(["%PDF-1.7"], "Jordan_Sample_Resume.pdf", { type: "application/pdf" });

function load(name: string): void {
  document.body.innerHTML = readFileSync(join(process.cwd(), "test", "fixtures", name), "utf8");
}
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const value = (selector: string) => $<HTMLInputElement>(selector).value;
const selected = (selector: string) => {
  const el = $<HTMLSelectElement>(selector);
  return el.options[el.selectedIndex]?.textContent?.trim();
};
const checkedLabel = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.closest("label")?.textContent?.trim();

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("knowing the sites", () => {
  it("recognises each site by its address", () => {
    expect(siteFor("https://boards.greenhouse.io/larkspur/jobs/123")?.name).toBe("Greenhouse");
    expect(siteFor("https://job-boards.greenhouse.io/larkspur/jobs/123")?.name).toBe("Greenhouse");
    expect(siteFor("https://jobs.lever.co/larkspur/abc/apply")?.name).toBe("Lever");
    expect(siteFor("https://jobs.ashbyhq.com/larkspur/abc/application")?.name).toBe("Ashby");
    expect(siteFor("https://careers.larkspur.example/apply")).toBeNull();
  });
});

describe("Greenhouse", () => {
  it("fills the form and leaves the open question", async () => {
    load("greenhouse.html");
    const report = await fillPage(document, PROFILE, RESUME, greenhouse);
    expect(value("#first_name")).toBe("Jordan");
    expect(value("#last_name")).toBe("Sample");
    expect(value("#email")).toBe("jordan.sample@example.com");
    expect(value("#phone")).toBe("555-010-0199");
    expect(value("#job_application_location")).toBe("Springfield, Illinois");
    expect($<HTMLInputElement>("#resume").files?.[0]?.name).toBe("Jordan_Sample_Resume.pdf");
    expect(selected("#education_school_name_0")).toBe("State University");
    expect(selected("#education_degree_0")).toBe("Bachelor's Degree");
    expect(selected("#education_discipline_0")).toBe("Computer Science");
    expect(value("#job_application_answers_attributes_0_text_value")).toBe("https://linkedin.com/in/jordan-sample");
    expect(value("#job_application_answers_attributes_1_text_value")).toBe("https://jordan.example");
    expect(selected("#job_application_answers_attributes_2_boolean_value")).toBe("Yes");
    expect(selected("#job_application_answers_attributes_3_boolean_value")).toBe("No");
    // Every demographic question declines, whatever the form calls it.
    expect(selected("#job_application_gender")).toBe("Decline To Self Identify");
    expect(selected("#job_application_hispanic_ethnicity")).toBe("Decline To Self Identify");
    expect(selected("#job_application_race")).toBe("Decline To Self Identify");
    expect(selected("#job_application_veteran_status")).toBe("I don't wish to answer");
    expect(selected("#job_application_disability_status")).toBe("I do not want to answer");

    expect(value("#job_application_answers_attributes_4_text_value")).toBe("");
    const left = report.left.map((el) => el.id);
    // Education dates and both employment blocks come from the profile's entries.
    expect(selected("#education_start_date_month_0")).toBe("September");
    expect(value("#education_start_date_year_0")).toBe("2023");
    expect(selected("#education_end_date_month_0")).toBe("May");
    expect(value("#education_end_date_year_0")).toBe("2027");
    expect(value("#employment_company_name_0")).toBe("Northwind Logistics");
    expect(value("#employment_title_0")).toBe("Software Engineering Intern");
    expect(selected("#employment_start_date_month_0")).toBe("June");
    expect(value("#employment_start_date_year_0")).toBe("2025");
    expect(selected("#employment_end_date_month_0")).toBe("August");
    expect(value("#employment_end_date_year_0")).toBe("2025");
    expect($<HTMLInputElement>("#employment_current_0").checked).toBe(false);
    expect(value("#employment_company_name_1")).toBe("Springfield Public Library");
    expect(selected("#employment_start_date_month_1")).toBe("January");
    expect(selected("#employment_end_date_month_1")).toBe("Month");
    expect($<HTMLInputElement>("#employment_current_1").checked).toBe(true);

    // "How did you hear about this job?" gets the profile's answer.
    expect(value("#job_application_answers_attributes_5_text_value")).toBe("Job board");
    expect(left).toEqual(["cover_letter", "job_application_answers_attributes_4_text_value"]);
    // 19 contact, school and question fields, 4 education dates, 7 + 5 employment fields.
    expect(report.filled).toHaveLength(19 + 4 + 12);
  });
});

describe("Lever", () => {
  it("fills named fields, the radio questions and the EEO selects", async () => {
    load("lever.html");
    const report = await fillPage(document, PROFILE, RESUME, lever);
    expect(value("input[name='name']")).toBe("Jordan Sample");
    expect(value("input[name='email']")).toBe("jordan.sample@example.com");
    expect(value("input[name='phone']")).toBe("555-010-0199");
    expect(value("input[name='location']")).toBe("Springfield, Illinois");
    expect($<HTMLInputElement>("input[name='resume']").files?.[0]?.name).toBe("Jordan_Sample_Resume.pdf");
    expect(value("input[name='urls[LinkedIn]']")).toBe("https://linkedin.com/in/jordan-sample");
    expect(value("input[name='urls[GitHub]']")).toBe("https://github.com/jordan-sample");
    expect(value("input[name='urls[Portfolio]']")).toBe("https://jordan.example");
    expect(checkedLabel("cards[5b1c][field0]")).toBe("Yes");
    expect(checkedLabel("cards[5b1c][field1]")).toBe("No");
    expect(value("input[name='cards[5b1c][field2]']")).toBe("05/2027");
    expect(selected("select[name='eeo[gender]']")).toBe("Decline to self-identify");
    expect(selected("select[name='eeo[race]']")).toBe("Decline to self-identify");
    expect(selected("select[name='eeo[veteran]']")).toBe("Decline to self-identify");
    expect(selected("select[name='eeo[disability]']")).toBe("I don't wish to answer");

    // The current company is the role marked current.
    expect(value("input[name='org']")).toBe("Springfield Public Library");

    // Left: Twitter (not in the profile), the open question, the cover letter
    // box, and the marketing consent box.
    const left = report.left.map((el) => el.getAttribute("name"));
    expect(left).toEqual(["urls[Twitter]", "cards[5b1c][field3]", "comments", "consent[marketing]"]);
    expect($<HTMLInputElement>("input[name='consent[marketing]']").checked).toBe(false);
    expect(report.filled).toHaveLength(16);
  });
});

describe("Ashby", () => {
  it("fills system fields, labelled questions and Yes/No buttons", async () => {
    load("ashby.html");
    const clicks: string[] = [];
    document.querySelectorAll("._yesno_container button").forEach((b) =>
      b.addEventListener("click", () => clicks.push(`${b.closest(".ashby-application-form-field-entry")!.querySelector("label")!.id}:${b.textContent}`)),
    );
    const report = await fillPage(document, PROFILE, RESUME, ashby);
    expect(value("#_systemfield_name")).toBe("Jordan Sample");
    expect(value("#_systemfield_email")).toBe("jordan.sample@example.com");
    expect(value("[id='5f3a1d2e-phone']")).toBe("555-010-0199");
    expect($<HTMLInputElement>("#_systemfield_resume").files?.[0]?.name).toBe("Jordan_Sample_Resume.pdf");
    expect(value("[id='9c1b-linkedin']")).toBe("https://linkedin.com/in/jordan-sample");
    expect(value("[id='9c1b-github']")).toBe("https://github.com/jordan-sample");
    expect(value("[id='9c1b-school']")).toBe("State University");
    expect(value("[id='9c1b-gpa']")).toBe("3.8");
    expect(clicks).toEqual(["q-auth-title:Yes", "q-sponsor-title:No"]);
    expect(checkedLabel("eeoc-gender")).toBe("Decline to self-identify");
    expect(checkedLabel("eeoc-veteran")).toBe("I don't wish to answer");
    expect(report.left.map((el) => el.id)).toEqual(["9c1b-why"]);
    expect(report.filled).toHaveLength(12);
  });
});

describe("any other site, by label", () => {
  it("matches fields by their labels, including a searchable dropdown", async () => {
    load("generic.html");
    // The dropdown shows its options once something is typed, like a real one.
    const combo = $<HTMLInputElement>("[role='combobox']");
    combo.addEventListener("input", () => {
      $("#sponsor-list").innerHTML = '<li role="option">Yes</li><li role="option">No</li>';
      $("#sponsor-list")
        .querySelectorAll("li")
        .forEach((li) => li.addEventListener("click", () => (combo.dataset.chosen = li.textContent ?? "")));
    });
    const report = await fillPage(document, PROFILE, RESUME, siteFor(location.href));
    expect(value("#given")).toBe("Jordan");
    expect(value("#surname")).toBe("Sample");
    expect(value("input[name='contact_email']")).toBe("jordan.sample@example.com");
    expect(value("input[name='mobile']")).toBe("555-010-0199");
    expect(value("#street")).toBe("100 Main St");
    expect(value("#city")).toBe("Springfield");
    expect(selected("#state")).toBe("Illinois");
    expect(value("#zip")).toBe("62701");
    expect(value("#uni")).toBe("State University");
    expect(value("#major")).toBe("Computer Science");
    expect(value("#gpa")).toBe("3.8");
    expect(value("#grad")).toBe("2027-05");
    expect(value("#li")).toBe("https://linkedin.com/in/jordan-sample");
    expect(value("#start")).toBe("05/17/2027");
    expect(combo.dataset.chosen).toBe("No");
    // Left: the referral code, the open question and the terms box. The preferred
    // name already had an answer, so it wasn't touched or counted.
    expect(report.left.map((el) => el.getAttribute("name"))).toEqual(["ref", "why", "terms"]);
    expect(value("#nick")).toBe("Jo");
    expect(report.already).toBe(1);
    expect(report.filled).toHaveLength(15);
  });
});

describe("never", () => {
  it("submits, clicks Submit, or overwrites an answer", async () => {
    for (const name of ["greenhouse.html", "lever.html", "ashby.html", "generic.html"]) {
      load(name);
      const form = document.querySelector("form")!;
      const submitted = vi.fn((e: Event) => e.preventDefault());
      form.addEventListener("submit", submitted);
      const submitButton = Array.from(document.querySelectorAll<HTMLElement>("button, input[type='button'], input[type='submit']")).find((b) =>
        /submit|send/i.test(b.textContent || (b as HTMLInputElement).value),
      )!;
      const clicked = vi.fn();
      submitButton.addEventListener("click", clicked);
      await fillPage(document, PROFILE, RESUME, siteFor(`https://${name.startsWith("greenhouse") ? "boards.greenhouse.io" : name.startsWith("lever") ? "jobs.lever.co" : name.startsWith("ashby") ? "jobs.ashbyhq.com" : "example.com"}/x`));
      expect(submitted, name).not.toHaveBeenCalled();
      expect(clicked, name).not.toHaveBeenCalled();
    }
  });

  it("changes a field that already has an answer", async () => {
    load("greenhouse.html");
    $<HTMLInputElement>("#email").value = "typed@example.com";
    const report = await fillPage(document, PROFILE, RESUME, greenhouse);
    expect(value("#email")).toBe("typed@example.com");
    expect(report.already).toBe(1);
  });
});

describe("matching rules", () => {
  it("reads labels", () => {
    expect(keyForLabel("First Name *")).toBe("firstName");
    expect(keyForLabel("Legal last name")).toBe("lastName");
    expect(keyForLabel("Full name")).toBe("fullName");
    expect(keyForLabel("Email address")).toBe("email");
    expect(keyForLabel("Will you now or in the future require sponsorship?")).toBe("needsSponsorship");
    expect(keyForLabel("Do you currently require visa sponsorship?")).toBe("sponsorshipNow");
    expect(keyForLabel("Will you require sponsorship in the future?")).toBe("sponsorshipFuture");
    expect(keyForLabel("Preferred first name")).toBe("preferredFirstName");
    expect(keyForLabel("Preferred name")).toBe("preferredFirstName");
    expect(keyForLabel("Preferred last name")).toBe("preferredLastName");
    expect(keyForLabel("Middle name")).toBe("middleName");
    expect(keyForLabel("Address line 2")).toBe("street2");
    expect(keyForLabel("Address line 1")).toBe("street");
    expect(keyForLabel("County")).toBe("county");
    expect(keyForLabel("Country")).toBe("country");
    expect(keyForLabel("Phone extension")).toBe("phoneExtension");
    expect(keyForLabel("Are you a U.S. citizen?")).toBe("usCitizen");
    expect(keyForLabel("Do you hold an active security clearance?")).toBe("hasClearance");
    expect(keyForLabel("Security clearance level")).toBe("securityClearance");
    expect(keyForLabel("Are you willing to relocate?")).toBe("willingToRelocate");
    expect(keyForLabel("Are you currently enrolled in a degree program?")).toBe("currentlyEnrolled");
    expect(keyForLabel("Available start date")).toBe("availableFrom");
    expect(keyForLabel("Available until")).toBe("availableUntil");
    expect(keyForLabel("Are you legally authorized to work in the United States?")).toBe("workAuthorized");
    expect(keyForLabel("Are you Hispanic/Latino?")).toBe("hispanicLatino");
    expect(keyForLabel("Race/Ethnicity")).toBe("race");
    expect(keyForLabel("Expected graduation date")).toBe("graduationDate");
    expect(keyForLabel("Favourite colour")).toBeNull();
  });

  it("knows an open question", () => {
    expect(looksLikeEssay("Why do you want to work here?")).toBe(true);
    expect(looksLikeEssay("Tell us about a time you failed")).toBe(true);
    expect(looksLikeEssay("Cover letter")).toBe(true);
    expect(looksLikeEssay("Phone")).toBe(false);
    expect(looksLikeEssay("What school do you attend?")).toBe(false);
  });

  it("picks the closest choice", () => {
    const decline = ["Male", "Female", "I don't wish to answer"];
    expect(bestChoice(decline, DECLINE)).toBe(2);
    expect(bestChoice(["Yes", "No, I do not"], "No")).toBe(1);
    expect(bestChoice(["I am a veteran", "I am not a veteran"], "I am not a protected veteran")).toBe(1);
    expect(bestChoice(["Male", "Female"], DECLINE)).toBe(-1);
    expect(bestChoice(["Asian (Not Hispanic or Latino)", "White (Not Hispanic or Latino)"], "Asian")).toBe(0);
  });
});
