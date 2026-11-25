/** Label normalization and the employer synonyms. */
import { describe, expect, it } from "vitest";
import { keyForLabel, keyInSection, normalizeLabel } from "../src/fill/keys";

describe("normalizing labels", () => {
  it("drops asterisks, slashes, punctuation and case", () => {
    expect(normalizeLabel("* Company / Organization")).toBe("company organization");
    expect(normalizeLabel("  *Job Title:  ")).toBe("job title");
    expect(normalizeLabel("Level of Education / Degree")).toBe("level of education degree");
    expect(normalizeLabel("Are you a Veteran? :")).toBe("are you a veteran");
    expect(normalizeLabel("Start Date (MM/DD/YYYY)")).toBe("start date mm dd yyyy");
  });

  it("keeps what words need: hyphens, apostrophes, the periods in U.S.", () => {
    expect(normalizeLabel("E-mail")).toBe("e-mail");
    expect(normalizeLabel("I’m currently enrolled")).toBe("i'm currently enrolled");
    expect(normalizeLabel("Are you a U.S. citizen?")).toBe("are you a u.s. citizen");
    expect(normalizeLabel("Résumé")).toBe("résumé");
  });
});

describe("the employer field", () => {
  it("answers to company, organization, employer and company / organization", () => {
    for (const label of ["Company", "Organization", "Organisation", "Employer", "Company / Organization", "* Company / Organization", "Company Name", "Employer name", "COMPANY:"]) {
      expect(keyForLabel(label), label).toBe("workCompany");
    }
  });

  it("isn't confused with questions that mention a company", () => {
    expect(keyForLabel("Have you previously worked for this company?")).toBe("workedHereBefore");
    expect(keyForLabel("Current company")).toBe("currentCompany");
  });
});

describe("names", () => {
  it("a name from a former job isn't the legal name", () => {
    expect(keyForLabel("Legal Name at Time of Employment")).toBe("previousName");
    expect(keyForLabel("Former name")).toBe("previousName");
    expect(keyForLabel("Legal name")).toBe("fullName");
  });
});

describe("dates inside a section", () => {
  it("Start Date and End Date are the entry's own under Work Experience or Education", () => {
    expect(keyInSection("Start Date", "work")).toBe("workStart");
    expect(keyInSection("End Date", "work")).toBe("workEnd");
    expect(keyInSection("From Date", "education")).toBe("eduStart");
    expect(keyInSection("End Date", "education")).toBe("graduationDate");
    expect(keyInSection("To (Actual or Expected)", "education")).toBe("graduationDate");
  });

  it("outside those sections, or for other labels, the usual rules apply", () => {
    expect(keyInSection("Start Date", null)).toBeNull();
    expect(keyInSection("Job Title", "work")).toBeNull();
    expect(keyForLabel("What date are you available to start?")).toBe("availableFrom");
  });
});
