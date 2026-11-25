/**
 * Dates for forms that want a full day.
 *
 * The profile keeps most dates as a month and year ("2025-05", or "May 2025"
 * in an older or imported profile). A form with a date picker wants a day too,
 * so the day is resolved by what the date means:
 *
 * - a start date with no day is the 1st of its month;
 * - an end date with no day is the last day of its month (February counts
 *   leap years);
 * - a date that has a day keeps it;
 * - "Present", or no end date at all, means the field is left blank.
 *
 * The result is written in the field's own format: its format-pattern
 * attribute (SAP UI5: "MM/dd/yyyy"), "yyyy-MM-dd" for <input type="date">, or
 * the pattern its placeholder shows ("MM/DD/YYYY").
 */

export interface DateParts {
  year: number;
  /** 1 to 12. */
  month: number;
  /** 1 to 31, or null when the source had no day. */
  day: number | null;
}

export type DateRole = "start" | "end";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const PRESENT = /^(present|current|now|ongoing|today)$/i;

function monthFromName(name: string): number | null {
  const i = MONTHS.indexOf(name.toLowerCase().slice(0, 3));
  return i >= 0 ? i + 1 : null;
}

function valid(year: number, month: number, day: number | null): DateParts | null {
  if (!(year >= 1900 && year <= 2200 && month >= 1 && month <= 12)) return null;
  if (day !== null && (day < 1 || day > daysInMonth(year, month))) return null;
  return { year, month, day };
}

/**
 * A date as the profile might hold it: "2025-05", "2025-05-16", "May 2025",
 * "Sept. 2025", "May 16, 2025", "16 May 2025", "05/2025" or "05/16/2025".
 * Null for "Present", blank text, or anything it can't read.
 */
export function parseProfileDate(text: string | null | undefined): DateParts | null {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  if (!t || PRESENT.test(t)) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (m) return valid(+m[1], +m[2], m[3] ? +m[3] : null);
  m = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return valid(+m[2], +m[1], null);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return valid(+m[3], +m[1], +m[2]);
  m = t.match(/^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/);
  if (m && monthFromName(m[1])) return valid(+m[3], monthFromName(m[1])!, +m[2]);
  m = t.match(/^(\d{1,2}) ([A-Za-z]+)\.?,? (\d{4})$/);
  if (m && monthFromName(m[2])) return valid(+m[3], monthFromName(m[2])!, +m[1]);
  m = t.match(/^([A-Za-z]+)\.?,? (\d{4})$/);
  if (m && monthFromName(m[1])) return valid(+m[2], monthFromName(m[1])!, null);
  return null;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** The day to use: the date's own, else the 1st for a start date and the last day of the month for an end date. */
export function resolveDay(date: DateParts, role: DateRole): Required<{ [K in keyof DateParts]: number }> {
  const day = date.day ?? (role === "start" ? 1 : daysInMonth(date.year, date.month));
  return { year: date.year, month: date.month, day };
}

/**
 * Write a date in a pattern of yyyy, yy, MM, M, dd and d, with any separators:
 * "MM/dd/yyyy", "yyyy-MM-dd", "dd.MM.yyyy". The pattern is the field's own.
 */
export function formatDate(date: { year: number; month: number; day: number }, pattern: string): string {
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return pattern.replace(/yyyy|yy|MM|M|dd|d/g, (token) => {
    switch (token) {
      case "yyyy":
        return String(date.year);
      case "yy":
        return pad(date.year % 100, 2);
      case "MM":
        return pad(date.month, 2);
      case "M":
        return String(date.month);
      case "dd":
        return pad(date.day, 2);
      default:
        return String(date.day);
    }
  });
}

/** The pattern a field writes dates in. "MM/dd/yyyy" when it doesn't say. */
export function patternFor(el: Element): string {
  const given = el.getAttribute("format-pattern") ?? el.getAttribute("data-format-pattern");
  if (given) return given;
  if (el instanceof HTMLInputElement && el.type === "date") return "yyyy-MM-dd";
  // A placeholder such as MM/DD/YYYY or DD.MM.YYYY: the same tokens in upper case.
  const placeholder = el.getAttribute("placeholder") ?? "";
  if (/(MM|M).*(DD|D).*(YYYY|YY)|(DD|D).*(MM|M).*(YYYY|YY)|(YYYY).*(MM|M).*(DD|D)/.test(placeholder)) {
    return placeholder.replace(/YYYY/g, "yyyy").replace(/YY/g, "yy").replace(/DD/g, "dd").replace(/\bD\b/g, "d");
  }
  return "MM/dd/yyyy";
}

/** Whether a field wants a full date (day included), not just a month and year. */
export function wantsFullDate(el: Element): boolean {
  if (el.tagName.toLowerCase().startsWith("ui5-date-picker")) return true;
  if (el instanceof HTMLInputElement && el.type === "date") return true;
  // A placeholder that shows a day: MM/DD/YYYY, DD.MM.YYYY, YYYY-MM-DD.
  const placeholder = (el.getAttribute("placeholder") ?? "").toUpperCase();
  return /(^|[^A-Z])D{1,2}([^A-Z]|$)/.test(placeholder) && /Y{2,4}/.test(placeholder);
}

/**
 * The text for a date field: the profile's date with its day resolved, in the
 * field's pattern. "" when the field should stay blank: no date, or "Present".
 */
export function dateForField(text: string | null | undefined, role: DateRole, pattern: string): string {
  const parts = parseProfileDate(text);
  return parts ? formatDate(resolveDay(parts, role), pattern) : "";
}
