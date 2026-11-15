/**
 * What the person sees after Autofill: one line ("Filled 14 fields, 3 left
 * for you") and an outline on every field left for them. An outline goes away
 * once its field is answered.
 *
 * The banner sits in a shadow root so the page's styles can't change it.
 */
import type { FillReport } from "./fill/engine";

const HOST_ID = "tailor-autofill-summary";
const OUTLINE = "2px solid #f59e0b";

export function summaryText(report: Pick<FillReport, "filled" | "left">): string {
  const filled = report.filled.length;
  const left = report.left.length;
  const fields = (n: number) => `${n} field${n === 1 ? "" : "s"}`;
  if (!filled && !left) return "No form fields found on this page.";
  return left ? `Filled ${fields(filled)}, ${left} left for you` : `Filled ${fields(filled)}`;
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
export function showSummary(doc: Document, report: Pick<FillReport, "filled" | "left">): HTMLElement {
  doc.getElementById(HOST_ID)?.remove();
  const host = doc.createElement("div");
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .box { position: fixed; right: 20px; bottom: 84px; z-index: 2147483647; display: flex; gap: 12px; align-items: center;
             padding: 12px 14px 12px 16px; border-radius: 12px; background: #17181a; color: #f4f4f2;
             font: 600 14px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #f59e0b; }
      .done .dot { background: #4ade80; }
      button { border: 0; background: transparent; color: inherit; font: inherit; font-size: 16px; cursor: pointer; padding: 0 2px; }
    </style>
    <div class="box" role="status"><span class="dot"></span><span class="text"></span><button type="button" aria-label="Close">×</button></div>`;
  const box = root.querySelector(".box")!;
  box.classList.toggle("done", report.left.length === 0);
  root.querySelector(".text")!.textContent = summaryText(report);
  root.querySelector("button")!.addEventListener("click", () => host.remove());
  doc.body.append(host);
  setTimeout(() => host.remove(), 12_000);
  return host;
}
