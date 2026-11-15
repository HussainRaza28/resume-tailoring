import { describe, expect, it } from "vitest";
import { highlight, showSummary, summaryText } from "../src/summary";

const els = (n: number) => Array.from({ length: n }, () => document.createElement("input"));

describe("summary", () => {
  it("says how many were filled and how many are left", () => {
    expect(summaryText({ filled: els(14), left: els(3) })).toBe("Filled 14 fields, 3 left for you");
    expect(summaryText({ filled: els(1), left: [] })).toBe("Filled 1 field");
    expect(summaryText({ filled: [], left: [] })).toBe("No form fields found on this page.");
  });

  it("shows one banner at a time, closed with its button", () => {
    showSummary(document, { filled: els(2), left: els(1) });
    const host = showSummary(document, { filled: els(5), left: [] });
    expect(document.querySelectorAll("#tailor-autofill-summary")).toHaveLength(1);
    expect(host.shadowRoot!.querySelector(".text")!.textContent).toBe("Filled 5 fields");
    host.shadowRoot!.querySelector("button")!.click();
    expect(document.getElementById("tailor-autofill-summary")).toBeNull();
  });

  it("outlines a field left for the person until it's answered", () => {
    const [input] = els(1);
    document.body.append(input);
    highlight([input]);
    expect(input.style.outline).toContain("solid");
    input.dispatchEvent(new Event("input"));
    expect(input.style.outline).toBe("");
    expect(input.dataset.tailorLeft).toBeUndefined();
  });

  it("outlines a hidden file input's visible box instead", () => {
    const box = document.createElement("div");
    const file = document.createElement("input");
    file.type = "file";
    file.style.display = "none";
    box.append(file);
    highlight([file]);
    expect(box.dataset.tailorLeft).toBe("true");
  });
});
