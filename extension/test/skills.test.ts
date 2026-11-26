/** Workday's skill names: qualifiers dropped, exact names first, known other names next, never a different skill. */
import { describe, expect, it } from "vitest";
import { matchSkill, skillKey } from "../src/fill/workdayWidgets";

const WORKDAY = ["Python (Programming Language)", "Django Admin", "Django", "C#", "C++", "C (Programming Language)", "R Programming", "Interactive SQL", "SQL", "Node.js", "Golang", "Amazon Web Services"];
const pick = (wanted: string, options = WORKDAY) => {
  const i = matchSkill(options, wanted);
  return i < 0 ? null : options[i];
};

describe("skill names", () => {
  it("drop parenthetical qualifiers and generic words, keep + # and .", () => {
    expect(skillKey("Python (Programming Language)")).toBe("python");
    expect(skillKey("R Programming")).toBe("r");
    expect(skillKey("C++")).toBe("c++");
    expect(skillKey("C#")).toBe("c#");
    expect(skillKey("C (Programming Language)")).toBe("c");
    expect(skillKey("Node.js")).toBe("node.js");
    expect(skillKey("  Interactive SQL ")).toBe("interactive sql");
  });

  it("pick the same skill, never a longer or different one", () => {
    expect(pick("Python")).toBe("Python (Programming Language)");
    expect(pick("Django")).toBe("Django");
    expect(pick("C")).toBe("C (Programming Language)");
    expect(pick("C++")).toBe("C++");
    expect(pick("C#")).toBe("C#");
    expect(pick("R")).toBe("R Programming");
    expect(pick("SQL")).toBe("SQL");
    expect(pick("Kubernetes")).toBeNull();
  });

  it("use known other names only when the name itself isn't there", () => {
    expect(pick("Go")).toBe("Golang");
    expect(pick("AWS")).toBe("Amazon Web Services");
    expect(pick("NodeJS")).toBe("Node.js");
    expect(pick("Django", ["Django Admin", "Django REST Framework"])).toBeNull();
    expect(pick("SQL", ["Interactive SQL", "SQL Server"])).toBeNull();
    expect(pick("C", ["C#", "C++", "Objective-C"])).toBeNull();
  });
});
