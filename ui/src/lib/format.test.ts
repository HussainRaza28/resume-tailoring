import { describe, expect, it } from "vitest";
import { clock, duration, median, money, pct, signed, tokens } from "./format";

describe("format", () => {
  it("money", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(0.0031)).toBe("$0.0031");
    expect(money(1.234)).toBe("$1.23");
    expect(money(null)).toBe("–");
  });
  it("tokens", () => {
    expect(tokens(950)).toBe("950");
    expect(tokens(12_400)).toBe("12k");
    expect(tokens(1_500)).toBe("1.5k");
    expect(tokens(2_300_000)).toBe("2.3M");
  });
  it("duration and clock", () => {
    expect(duration(38_200)).toBe("38 s");
    expect(duration(125_000)).toBe("2 m 5 s");
    expect(duration(3_720_000)).toBe("1 h 2 m");
    expect(duration(null)).toBe("–");
    expect(clock(247_000)).toBe("04:07");
    expect(clock(3_729_000)).toBe("1:02:09");
  });
  it("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it("pct and signed", () => {
    expect(pct(0.756)).toBe("76%");
    expect(pct(undefined)).toBe("–");
    expect(signed(12)).toBe("+12");
    expect(signed(-3)).toBe("-3");
    expect(signed(0)).toBe("0");
  });
});
