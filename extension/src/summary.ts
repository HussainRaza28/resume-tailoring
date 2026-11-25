/**
 * What the person sees after Autofill: one line ("Filled 14 fields, 3 left
 * for you, 1 didn't stick") and an outline on every field left for them. An
 * outline goes away once its field is answered. "Details" in the banner lists
 * the fields by label under Filled, Skipped, Didn't stick and Left for you, and
 * the same list goes to the console as a collapsed group. Only labels are
 * listed, never what was typed.
 *
 * The banner sits in a shadow root so the page's styles can't change it.
 */
import type { FillReport } from "./fill/engine";

const HOST_ID = "tailor-autofill-summary";
// The app's warning amber, for fields left for the person.
const OUTLINE = "2px solid #e5a93b";

/** The app's font, for the button and banner drawn into job sites' pages. */
export const PAGE_STYLE = `:host { --font: "Inter Variable", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif; }`;

type Summary = Pick<FillReport, "filled" | "left"> & Partial<Pick<FillReport, "skipped" | "failed" | "labels">>;

export function summaryText(report: Summary): string {
  const filled = report.filled.length;
  const failed = report.failed?.length ?? 0;
  // Fields that didn't stick are left for the person too, but counted on their own.
  const left = report.left.length - failed;
  const fields = (n: number) => `${n} field${n === 1 ? "" : "s"}`;
  if (!filled && !left && !failed) return "No form fields found on this page.";
  const parts = [`Filled ${fields(filled)}`];
  if (left) parts.push(`${left} left for you`);
  if (failed) parts.push(`${failed} didn't stick`);
  return parts.join(", ");
}

export interface ReportGroup {
  title: string;
  labels: string[];
}

/** The fields in a report by outcome, each as its label. */
export function reportGroups(report: Summary): ReportGroup[] {
  const name = (el: HTMLElement) => report.labels?.get(el) || el.getAttribute("name") || el.id || el.tagName.toLowerCase();
  const failed = new Set(report.failed ?? []);
  return [
    { title: "Filled", labels: report.filled.map(name) },
    { title: "Skipped", labels: (report.skipped ?? []).map(name) },
    { title: "Didn't stick", labels: (report.failed ?? []).map(name) },
    { title: "Left for you", labels: report.left.filter((el) => !failed.has(el)).map(name) },
  ].filter((g) => g.labels.length);
}

/** The report as a collapsed console group, for checking a run in DevTools. */
export function logReport(report: Summary): void {
  console.groupCollapsed(`Tailor Autofill: ${summaryText(report)}`);
  for (const group of reportGroups(report)) console.log(`${group.title} (${group.labels.length}):\n  ${group.labels.join("\n  ")}`);
  console.groupEnd();
}

/** Outline the fields left for the person, and drop each outline once it's answered. */
export function highlight(elements: HTMLElement[]): void {
  for (const el of elements) {
    // A hidden file input can't show an outline; its visible container can.
    const target = el instanceof HTMLInputElement && el.type === "file" && el.style.display === "none" ? (el.parentElement ?? el) : el;
    target.dataset.tailorLeft = "true";
    target.style.outline = OUTLINE;
    target.style.outlineOffset = "2px";
    const clear = () => {
      target.style.outline = "";
      target.style.outlineOffset = "";
      delete target.dataset.tailorLeft;
    };
    el.addEventListener("input", clear, { once: true });
    el.addEventListener("change", clear, { once: true });
  }
}

/** Show the summary line in the corner of the page until it's closed or 12 seconds pass. */
export function showSummary(doc: Document, report: Summary): HTMLElement {
  doc.getElementById(HOST_ID)?.remove();
  const host = doc.createElement("div");
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${PAGE_STYLE}
      .box { position: fixed; right: 20px; bottom: 76px; z-index: 2147483647; display: flex; gap: 12px; align-items: center;
             padding: 12px 10px 12px 16px; border-radius: 12px; background: #171615; color: #f4f4f2;
             border: 1px solid rgba(255, 255, 255, 0.08); font: 500 14px/1.3 var(--font);
             box-shadow: 0 18px 40px -18px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(0, 0, 0, 0.2);
             animation: rise 220ms cubic-bezier(0.22, 1, 0.36, 1); }
      @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
      @media (prefers-reduced-motion: reduce) { .box { animation: none; } }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #e5a93b; flex: none; }
      .done .dot { background: #c6f24e; }
      button { border: 0; border-radius: 999px; width: 26px; height: 26px; background: transparent; color: #b5b1aa;
               font: inherit; font-size: 16px; cursor: pointer; }
      button:hover { background: #242220; color: #f4f4f2; }
      .wrap { position: fixed; right: 20px; bottom: 76px; z-index: 2147483647; display: grid; justify-items: end; gap: 8px; }
      .wrap .box { position: static; }
      details { max-width: 340px; max-height: 46vh; overflow: auto; padding: 10px 14px; border-radius: 12px; background: #171615;
                color: #b5b1aa; border: 1px solid rgba(255, 255, 255, 0.08); font: 400 12px/1.45 var(--font); }
      summary { cursor: pointer; color: #f4f4f2; font-weight: 500; }
      h4 { margin: 10px 0 2px; font-size: 12px; color: #f4f4f2; }
      ul { margin: 0; padding-left: 16px; }
    </style>
    <div class="wrap">
      <div class="box" role="status"><span class="dot"></span><span class="text"></span><button type="button" aria-label="Close">×</button></div>
    </div>`;
  const box = root.querySelector(".box")!;
  box.classList.toggle("done", report.left.length === 0);
  root.querySelector(".text")!.textContent = summaryText(report);
  root.querySelector("button")!.addEventListener("click", () => host.remove());
  // The fields by label, under a Details toggle. Built with text nodes: labels come from the page.
  const groups = reportGroups(report);
  const timer = setTimeout(() => host.remove(), 12_000);
  if (groups.length) {
    const details = doc.createElement("details");
    const summary = doc.createElement("summary");
    summary.textContent = "Details";
    details.append(summary);
    for (const group of groups) {
      const heading = doc.createElement("h4");
      heading.textContent = `${group.title} (${group.labels.length})`;
      const list = doc.createElement("ul");
      for (const label of group.labels) {
        const item = doc.createElement("li");
        item.textContent = label;
        list.append(item);
      }
      details.append(heading, list);
    }
    // Opening the list keeps the banner up until it's closed.
    details.addEventListener("toggle", () => clearTimeout(timer));
    root.querySelector(".wrap")!.append(details);
  }
  doc.body.append(host);
  return host;
}
