import { describe, expect, it } from "vitest";
import { fitScale } from "./fit";

const letter = { width: 612, height: 792 };

describe("fitScale", () => {
  it("is limited by height in a wide, short pane", () => {
    const s = fitScale(letter, { width: 1200, height: 600 });
    expect(letter.height * s).toBeCloseTo(600);
    expect(letter.width * s).toBeLessThanOrEqual(1200);
  });

  it("is limited by width in a narrow, tall pane", () => {
    const s = fitScale(letter, { width: 400, height: 1400 });
    expect(letter.width * s).toBeCloseTo(400);
    expect(letter.height * s).toBeLessThanOrEqual(1400);
  });

  it("always fits both ways", () => {
    for (const box of [{ width: 300, height: 300 }, { width: 900, height: 700 }, { width: 640, height: 2000 }]) {
      const s = fitScale(letter, box);
      expect(letter.width * s).toBeLessThanOrEqual(box.width + 1e-9);
      expect(letter.height * s).toBeLessThanOrEqual(box.height + 1e-9);
    }
  });

  it("is zero for an empty box", () => {
    expect(fitScale(letter, { width: 0, height: 500 })).toBe(0);
  });
});
