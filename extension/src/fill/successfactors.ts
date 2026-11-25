/**
 * SAP SuccessFactors career sites (such as ascendlearning.jobs.hr.cloud.sap).
 *
 * The application form is one page of sections. Work Experience and Education
 * start with one row each and an "Add new row" button. Before the general pass
 * fills anything, this presses Add until each of those sections has a row for
 * every entry in the profile, waiting for each new row to appear. Adding rows
 * first means no row is added, and the section re-rendered, after its fields
 * are filled. The general pass then fills row n from entry n.
 *
 * Only the Add button is ever pressed: never a row's Remove, never Submit.
 */
import type { Profile } from "../profile";
import { isVisible, waitFor } from "./dom";
import type { FillReport } from "./engine";

/** How long to give SuccessFactors to draw a new row, and to settle after one. */
const ROW_TIMEOUT_MS = 4000;
const ROW_SETTLE_MS = 150;

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a section holds, from its title. */
export function sectionKind(section: Element): "work" | "education" | null {
  const title = (section.querySelector(".sectionTitle, .rcmFormSectionTitle, h2, h3")?.textContent ?? "").toLowerCase();
  if (/work experience|employment|work history|professional experience/.test(title)) return "work";
  if (/education/.test(title)) return "education";
  return null;
}

/** The rows in a section: one element per row ("116:_sectionComponent"). */
export function rowsIn(section: Element): HTMLElement[] {
  return Array.from(section.querySelectorAll<HTMLElement>("[id$='_sectionComponent'], .rcmSectionComponent")).filter(
    (row, i, all) => all.indexOf(row) === i && !row.parentElement?.closest("[id$='_sectionComponent'], .rcmSectionComponent"),
  );
}

/** The section's "Add new row" button. Null when it has none (a section with a fixed set of fields). */
export function addRowButton(section: Element): HTMLElement | null {
  const button = section.querySelector<HTMLElement>("[id$='_addRowBtn'], .addRowButton, [role='button'][title='Add new row' i]");
  return button && isVisible(button) ? button : null;
}

/** Press Add in Work Experience and Education until there's a row for every role and school. */
export async function addSuccessFactorsRows(
  root: ParentNode,
  profile: Profile,
  _resume: File | null,
  _report: FillReport,
  _handled: Set<HTMLElement>,
): Promise<void> {
  const sections = Array.from(root.querySelectorAll<HTMLElement>("[id$=':section'], .rcmFormSection"));
  for (const section of sections) {
    const kind = sectionKind(section);
    const wanted = kind === "work" ? profile.work.length : kind === "education" ? profile.education.length : 0;
    while (rowsIn(section).length < wanted) {
      const button = addRowButton(section);
      if (!button) break;
      const before = rowsIn(section).length;
      button.click();
      const grown = await waitFor(() => (rowsIn(section).length > before ? [section] : []), ROW_TIMEOUT_MS);
      if (!grown.length) break;
      await settle(ROW_SETTLE_MS);
    }
  }
}
