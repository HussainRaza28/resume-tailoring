import { describe, expect, it } from "vitest";
import type { CheckedRewrite, RewriteSummary, RunState } from "./api";
import { rewriteNote } from "./rewriteNote";

const line = (status: CheckedRewrite["status"]) => ({ bullet_id: "b1", status }) as CheckedRewrite;
const summary = (s: Partial<RewriteSummary>) =>
  ({ lines: 1, changed: 0, blocked: 0, same_text: 0, skipped: 0, bold_only: 0, reorder_only: 0, unknown_ids: [], retried: false, retry_error: "", had_advice: true, block_reasons: [], message: "", ...s }) as RewriteSummary;
const run = (r: Partial<RunState>) => ({ rewrites: [], rewrite_summary: null, error: null, ...r }) as RunState;

describe("rewriteNote", () => {
  it("says why nothing changed, from the summary", () => {
    const message = "The model returned every line unchanged after a second try that listed the advice, so there is nothing to review.";
    expect(rewriteNote(run({ rewrites: [line("unchanged")], rewrite_summary: summary({ message }) }))).toBe(message);
  });

  it("says no changes were needed only when the summary has nothing else to say", () => {
    expect(rewriteNote(run({ rewrites: [line("unchanged")], rewrite_summary: summary({ had_advice: false }) }))).toBe("No changes needed.");
    expect(rewriteNote(run({ rewrites: [line("ok")], rewrite_summary: summary({ changed: 1 }) }))).toBeNull();
  });

  it("says nothing for a failed rewrite: the error notice covers it", () => {
    expect(rewriteNote(run({ error: { kind: "server", message: "Overloaded" } }))).toBeNull();
  });

  it("never says no changes were needed when the rewrite didn't run", () => {
    expect(rewriteNote(run({}))).toBe("The rewrite hasn't run yet.");
  });
});
