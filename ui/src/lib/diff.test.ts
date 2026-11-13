import { describe, expect, it } from "vitest";
import { changedShare, side, tokenize, wordDiff } from "./diff";

describe("wordDiff", () => {
  it("returns one same run for identical text", () => {
    expect(wordDiff("Built a thing", "Built a thing")).toEqual([{ kind: "same", text: "Built a thing" }]);
  });

  it("marks replaced words and keeps both sides recoverable", () => {
    const a = "Worked with the team on various backend tasks";
    const b = "Shipped 3 backend services with the team";
    const ops = wordDiff(a, b);
    expect(side(ops, "old")).toBe(a);
    expect(side(ops, "new")).toBe(b);
    expect(ops.some((o) => o.kind === "added" && o.text.includes("Shipped"))).toBe(true);
    expect(ops.some((o) => o.kind === "removed" && o.text.includes("various"))).toBe(true);
  });

  it("keeps numbers with their units as one token", () => {
    expect(tokenize("cut calls 75% from 12,000 to 3k/day")).toContain("12,000");
    expect(tokenize("cut 75% now")).toContain("75%");
    expect(wordDiff("from 12,000 calls", "from 3,000 calls")).toEqual([
      { kind: "same", text: "from " },
      { kind: "removed", text: "12,000" },
      { kind: "added", text: "3,000" },
      { kind: "same", text: " calls" },
    ]);
  });

  it("handles empty sides", () => {
    expect(wordDiff("", "new words")).toEqual([{ kind: "added", text: "new words" }]);
    expect(wordDiff("old words", "")).toEqual([{ kind: "removed", text: "old words" }]);
  });

  it("groups a phrase swap and reports the changed share", () => {
    const ops = wordDiff("a quick brown fox", "a slow red fox");
    expect(ops.map((o) => o.kind)).toEqual(["same", "removed", "added", "same"]);
    expect(ops[1].text).toBe("quick brown");
    expect(ops[2].text).toBe("slow red");
    expect(changedShare(ops)).toBeGreaterThan(0);
    expect(changedShare(wordDiff("x", "x"))).toBe(0);
  });

  it("round-trips random edits", () => {
    const words = "built shipped cut 40% Go Kubernetes agent health checks for 4 components team API".split(" ");
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let t = 0; t < 300; t++) {
      const pick = () =>
        Array.from({ length: Math.floor(rnd() * 12) }, () => words[Math.floor(rnd() * words.length)]).join(" ");
      const a = pick();
      const b = pick();
      const ops = wordDiff(a, b);
      expect(side(ops, "old")).toBe(a);
      expect(side(ops, "new")).toBe(b);
    }
  });
});
