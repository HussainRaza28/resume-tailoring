/** Dates for forms that want a day: reading the profile's dates, resolving the day, writing the field's format. */
import { describe, expect, it } from "vitest";
import {
  dateForField,
  daysInMonth,
  formatDate,
  isLeapYear,
  parseProfileDate,
  patternFor,
  resolveDay,
  wantsFullDate,
} from "../src/fill/dates";

describe("reading the profile's dates", () => {
  it("reads month and year in the forms a profile holds them", () => {
    expect(parseProfileDate("2025-05")).toEqual({ year: 2025, month: 5, day: null });
    expect(parseProfileDate("May 2025")).toEqual({ year: 2025, month: 5, day: null });
    expect(parseProfileDate("August 2025")).toEqual({ year: 2025, month: 8, day: null });
    expect(parseProfileDate("Sept. 2025")).toEqual({ year: 2025, month: 9, day: null });
    expect(parseProfileDate("05/2025")).toEqual({ year: 2025, month: 5, day: null });
  });

  it("keeps an explicit day", () => {
    expect(parseProfileDate("2025-05-16")).toEqual({ year: 2025, month: 5, day: 16 });
    expect(parseProfileDate("May 16, 2025")).toEqual({ year: 2025, month: 5, day: 16 });
    expect(parseProfileDate("16 May 2025")).toEqual({ year: 2025, month: 5, day: 16 });
    expect(parseProfileDate("05/16/2025")).toEqual({ year: 2025, month: 5, day: 16 });
  });

  it("reads Present, blanks and nonsense as no date", () => {
    for (const text of ["Present", "present", "Current", "", "   ", undefined, null, "soon", "2025-13", "2025-02-30"]) {
      expect(parseProfileDate(text), String(text)).toBeNull();
    }
  });
});

describe("resolving the day", () => {
  it("a start with no day is the 1st", () => {
    expect(resolveDay({ year: 2025, month: 5, day: null }, "start")).toEqual({ year: 2025, month: 5, day: 1 });
  });

  it("an end with no day is the last day of its month", () => {
    expect(resolveDay({ year: 2025, month: 8, day: null }, "end").day).toBe(31);
    expect(resolveDay({ year: 2025, month: 4, day: null }, "end").day).toBe(30);
    expect(resolveDay({ year: 2025, month: 12, day: null }, "end").day).toBe(31);
  });

  it("February counts leap years", () => {
    expect(resolveDay({ year: 2025, month: 2, day: null }, "end").day).toBe(28);
    expect(resolveDay({ year: 2024, month: 2, day: null }, "end").day).toBe(29);
    expect(resolveDay({ year: 2000, month: 2, day: null }, "end").day).toBe(29); // divisible by 400
    expect(resolveDay({ year: 1900, month: 2, day: null }, "end").day).toBe(28); // by 100, not 400
    expect([isLeapYear(2028), isLeapYear(2100), daysInMonth(2028, 2)]).toEqual([true, false, 29]);
  });

  it("an explicit day wins, for a start or an end", () => {
    expect(resolveDay({ year: 2025, month: 5, day: 16 }, "start").day).toBe(16);
    expect(resolveDay({ year: 2025, month: 5, day: 16 }, "end").day).toBe(16);
    expect(parseProfileDate("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseProfileDate("2025-02-29")).toBeNull();
  });
});

describe("writing the field's format", () => {
  const d = { year: 2025, month: 5, day: 1 };
  it("follows the pattern", () => {
    expect(formatDate(d, "MM/dd/yyyy")).toBe("05/01/2025");
    expect(formatDate(d, "yyyy-MM-dd")).toBe("2025-05-01");
    expect(formatDate(d, "dd.MM.yyyy")).toBe("01.05.2025");
    expect(formatDate(d, "M/d/yy")).toBe("5/1/25");
  });

  it("takes the pattern from the field", () => {
    const el = (html: string) => {
      document.body.innerHTML = html;
      return document.body.firstElementChild!;
    };
    expect(patternFor(el('<ui5-date-picker-x format-pattern="MM/dd/yyyy" placeholder="MM/DD/YYYY"></ui5-date-picker-x>'))).toBe("MM/dd/yyyy");
    expect(patternFor(el('<input type="date">'))).toBe("yyyy-MM-dd");
    expect(patternFor(el('<input placeholder="DD/MM/YYYY">'))).toBe("dd/MM/yyyy");
    expect(patternFor(el("<input>"))).toBe("MM/dd/yyyy");
    expect(wantsFullDate(el('<input placeholder="MM/DD/YYYY">'))).toBe(true);
    expect(wantsFullDate(el('<input type="date">'))).toBe(true);
    expect(wantsFullDate(el('<input placeholder="MM/YYYY">'))).toBe(false);
    expect(wantsFullDate(el("<input>"))).toBe(false);
  });
});

describe("the date for a field", () => {
  it("May 2025 to August 2025 is 05/01/2025 to 08/31/2025", () => {
    expect(dateForField("May 2025", "start", "MM/dd/yyyy")).toBe("05/01/2025");
    expect(dateForField("August 2025", "end", "MM/dd/yyyy")).toBe("08/31/2025");
    expect(dateForField("2024-02", "end", "yyyy-MM-dd")).toBe("2024-02-29");
    expect(dateForField("2025-05-16", "end", "MM/dd/yyyy")).toBe("05/16/2025");
  });

  it("Present or no end date leaves the field blank", () => {
    expect(dateForField("Present", "end", "MM/dd/yyyy")).toBe("");
    expect(dateForField("", "end", "MM/dd/yyyy")).toBe("");
  });
});
