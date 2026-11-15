/** Word-level diff for old vs new bullets. Pure, so it is unit tested. */

export type DiffOp = { kind: "same" | "added" | "removed"; text: string };

/** Split into words, numbers-with-units and whitespace, keeping every character. */
export function tokenize(s: string): string[] {
  return s.match(/\s+|[\p{L}\p{N}][\p{L}\p{N}'’.,%+#/&-]*[\p{L}\p{N}%+#]|[\p{L}\p{N}]|[^\s]/gu) ?? [];
}

/** LCS diff over tokens, merged into runs. Inside each changed span the removed
 *  text comes before the added text. */
export function wordDiff(oldText: string, newText: string): DiffOp[] {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const raw: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ kind: "removed", text: a[i++] });
    } else {
      raw.push({ kind: "added", text: b[j++] });
    }
  }
  while (i < n) raw.push({ kind: "removed", text: a[i++] });
  while (j < m) raw.push({ kind: "added", text: b[j++] });

  // A lone whitespace token between two changes belongs to the change on both sides,
  // so "quick brown" -> "slow red" reads as one phrase swap, not two.
  const ops: DiffOp[] = [];
  for (let k = 0; k < raw.length; k++) {
    const op = raw[k];
    const prev = raw[k - 1];
    const next = raw[k + 1];
    if (op.kind === "same" && /^\s+$/.test(op.text) && prev && next && prev.kind !== "same" && next.kind !== "same") {
      ops.push({ kind: "removed", text: op.text }, { kind: "added", text: op.text });
      continue;
    }
    ops.push(op);
  }

  const out: DiffOp[] = [];
  let removed = "";
  let added = "";
  const flush = () => {
    if (removed) out.push({ kind: "removed", text: removed });
    if (added) out.push({ kind: "added", text: added });
    removed = "";
    added = "";
  };
  for (const op of ops) {
    if (op.kind === "removed") removed += op.text;
    else if (op.kind === "added") added += op.text;
    else {
      flush();
      const last = out[out.length - 1];
      if (last && last.kind === "same") last.text += op.text;
      else out.push({ ...op });
    }
  }
  flush();
  return out;
}

/** Rebuild one side from a diff. */
export function side(ops: DiffOp[], which: "old" | "new"): string {
  return ops
    .filter((o) => o.kind === "same" || (which === "old" ? o.kind === "removed" : o.kind === "added"))
    .map((o) => o.text)
    .join("");
}

/** Share of characters that changed, 0 to 1. */
export function changedShare(ops: DiffOp[]): number {
  const total = ops.reduce((n, o) => n + o.text.length, 0);
  const changed = ops.filter((o) => o.kind !== "same").reduce((n, o) => n + o.text.length, 0);
  return total ? changed / total : 0;
}

/** Text without its **bold** markers, and which characters of it were bold. */
export function parseBold(text: string): { plain: string; bold: boolean[] } {
  let plain = "";
  const bold: boolean[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    for (const c of text.slice(last, m.index)) {
      plain += c;
      bold.push(false);
    }
    for (const c of m[1]) {
      plain += c;
      bold.push(true);
    }
    last = m.index + m[0].length;
  }
  for (const c of text.slice(last)) {
    plain += c;
    bold.push(false);
  }
  return { plain, bold };
}

export type Run = { text: string; bold: boolean };

/** Cut ``text`` (which starts at ``offset`` in the plain side) into runs of bold and normal text. */
export function boldRuns(text: string, bold: boolean[], offset: number): Run[] {
  const runs: Run[] = [];
  for (let i = 0; i < text.length; i++) {
    const b = bold[offset + i] ?? false;
    const last = runs[runs.length - 1];
    if (last && last.bold === b) last.text += text[i];
    else runs.push({ text: text[i], bold: b });
  }
  return runs;
}
