/**
 * What the person sees after Autofill: one line ("Filled 14 fields, 3 left
 * for you") and an outline on every field left for them. An outline goes away
 * once its field is answered.
 *
 * The banner sits in a shadow root so the page's styles can't change it.
 */
import type { FillReport } from "./fill/engine";

const HOST_ID = "tailor-autofill-summary";
// The app's warning amber, for fields left for the person.
const OUTLINE = "2px solid #e5a93b";

/** The app's font, for the button and banner drawn into job sites' pages. */
export const PAGE_STYLE = `:host { --font: "Inter Variable", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif; }`;

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
