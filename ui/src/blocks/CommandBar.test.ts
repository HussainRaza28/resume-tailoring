import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./CommandBar";

describe("fuzzyScore", () => {
  it("matches everything for an empty query", () => {
    expect(fuzzyScore("", "Open settings")).toBe(1);
  });
  it("prefers substring matches, earlier first", () => {
    expect(fuzzyScore("set", "Open settings")).toBeGreaterThan(fuzzyScore("set", "Reset the theme toggle"));
    expect(fuzzyScore("set", "Settings")).toBeGreaterThan(fuzzyScore("set", "Open settings"));
  });
  it("matches characters in order and rejects missing ones", () => {
    expect(fuzzyScore("tgl thm", "Toggle theme")).toBeGreaterThan(0);
    expect(fuzzyScore("xyz", "Toggle theme")).toBe(0);
  });
});
