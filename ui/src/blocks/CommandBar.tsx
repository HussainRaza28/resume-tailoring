/**
 * Command bar.
 * Rebuilt from the public listing of the bencho.dev "Command bar" block (a type
 * interaction). Not the original source; swap for the original when available
 * (see src/blocks/SOURCE.md).
 *
 * Cmd/Ctrl+K opens it. Type to filter, arrows to move, Enter to run, Esc to close.
 * Focus returns to where it was when the bar closes.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

export type Command = {
  id: string;
  label: string;
  group: string;
  hint?: string;
  icon?: ReactNode;
  keywords?: string;
  run: () => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  placeholder?: string;
};

/** Order-preserving fuzzy match: every query character appears in order. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) {
    // a match at the start of a word beats one inside a word
    const wordStart = new RegExp(`(^|[^a-z0-9])${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(t);
    return wordStart ? 200 - wordStart.index : 100 - t.indexOf(q);
  }
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    score += found === ti ? 3 : 1;
    ti = found + 1;
  }
  return score;
}

export default function CommandBar({ open, onClose, commands, placeholder = "Type a command or search" }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const returnTo = useRef<Element | null>(null);

  const results = useMemo(() => {
    return commands
      .map((c) => ({ c, s: fuzzyScore(query, `${c.label} ${c.keywords ?? ""} ${c.group}`) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => (query ? b.s - a.s : 0))
      .map((r) => r.c);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement;
      setQuery("");
      setIndex(0);
      requestAnimationFrame(() => input.current?.focus());
    } else if (returnTo.current instanceof HTMLElement) {
      returnTo.current.focus();
    }
  }, [open]);

  useEffect(() => setIndex(0), [query]);

  if (!open) return null;

  const runAt = (i: number) => {
    const c = results[i];
    if (!c) return;
    onClose();
    setTimeout(c.run, 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      setIndex((i) => Math.min(results.length - 1, i + 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setIndex((i) => Math.max(0, i - 1));
      e.preventDefault();
    } else if (e.key === "Enter") {
      runAt(index);
      e.preventDefault();
    } else if (e.key === "Escape") {
      onClose();
      e.preventDefault();
    }
  };

  let lastGroup = "";
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdbar" role="dialog" aria-modal="true" aria-label="Command bar" onKeyDown={onKeyDown}>
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          role="combobox"
          aria-expanded="true"
          aria-controls="cmd-list"
          aria-activedescendant={results[index] ? `cmd-${results[index].id}` : undefined}
        />
        <div className="cmd-list" id="cmd-list" role="listbox">
          {results.length === 0 && <div className="cmd-empty">No command matches “{query}”.</div>}
          {results.map((c, i) => {
            const head = !query && c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head && <div className="cmd-group">{head}</div>}
                <button
                  id={`cmd-${c.id}`}
                  className="cmd-item"
                  role="option"
                  aria-selected={i === index}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => runAt(i)}
                >
                  {c.icon}
                  <span>{c.label}</span>
                  {c.hint && <span className="kbd">{c.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
