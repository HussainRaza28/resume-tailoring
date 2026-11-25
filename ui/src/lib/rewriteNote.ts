import type { RunState } from "./api";

/**
 * The line shown above the rewrites: why nothing changed, or what was dropped.
 *
 * It comes from the summary the backend saves with each rewrite. "No changes
 * needed" is only said when the score gave no advice to act on. A failed
 * rewrite has no summary; the error notice explains it, so this says nothing.
 */
export function rewriteNote(run: RunState): string | null {
  const changed = run.rewrites.filter((r) => r.status !== "unchanged").length;
  const summary = run.rewrite_summary;
  if (summary) {
    if (summary.message) return summary.message;
    return changed === 0 ? "No changes needed." : null;
  }
  if (run.error) return null;
  if (run.rewrites.length === 0) return "The rewrite hasn't run yet.";
  // A run saved before summaries were kept.
  return changed === 0 ? "The model returned every line unchanged." : null;
}
