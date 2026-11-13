/**
 * Dropdown menu.
 * Rebuilt from the public listing of the bencho.dev "Dropdown" block (a press
 * interaction). Not the original source; swap for the original when available
 * (see src/blocks/SOURCE.md).
 */
import { type ReactNode, useEffect, useRef, useState } from "react";

export type MenuOption = { value: string; label: string; detail?: string; group?: string; disabled?: boolean };

type Props = {
  label: string;
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
  trigger: ReactNode;
  align?: "left" | "right";
};

export default function Menu({ label, value, options, onChange, trigger, align = "right" }: Props) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setIndex(Math.max(0, options.findIndex((o) => o.value === value)));
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open, options, value]);

  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    button.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") setIndex((i) => Math.min(options.length - 1, i + 1));
    else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
    else if (e.key === "Enter") choose(index);
    else if (e.key === "Escape") {
      setOpen(false);
      button.current?.focus();
    } else return;
    e.preventDefault();
  };

  let lastGroup: string | undefined;
  return (
    <div ref={box} style={{ position: "relative" }} onKeyDown={onKeyDown}>
      <button
        ref={button}
        className="btn btn-ghost btn-sm"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div className="menu" role="listbox" aria-label={label} style={{ top: 40, [align]: 0 }}>
          {options.map((o, i) => {
            const head = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            return (
              <div key={o.value}>
                {head && <div className="menu-label">{head}</div>}
                <button
                  className="menu-item"
                  role="option"
                  aria-selected={i === index}
                  aria-disabled={o.disabled}
                  disabled={o.disabled}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => choose(i)}
                >
                  <span style={{ display: "grid" }}>
                    <span>{o.label}</span>
                    {o.detail && <span className="small faint">{o.detail}</span>}
                  </span>
                  {o.value === value && (
                    <svg className="check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="Selected">
                      <path d="m5 12.5 4.5 4.5L19 7.5" />
                    </svg>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
