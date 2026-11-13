/**
 * Toast stack.
 * Rebuilt from the public listing of the bencho.dev "Toast stack" block (a hover
 * interaction). Not the original source; swap for the original when available
 * (see src/blocks/SOURCE.md).
 *
 * Toasts pile up behind each other; hovering the pile fans them out. Each toast
 * can carry one action. Errors stay until dismissed, others leave after 5 s.
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";

export type ToastTone = "info" | "success" | "error";
export type Toast = {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
};

type Ctx = { push: (t: Omit<Toast, "id">) => void; dismiss: (id: number) => void };
const ToastCtx = createContext<Ctx>({ push: () => {}, dismiss: () => {} });

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hover, setHover] = useState(false);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = next.current++;
      setToasts((ts) => [...ts.slice(-4), { ...t, id }]);
      if (t.tone !== "error") setTimeout(() => dismiss(id), 5000);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  const shown = toasts.slice(-3);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        className="toasts"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {shown.map((t, i) => {
          const depth = shown.length - 1 - i;
          const y = hover ? -depth * 74 : -depth * 10;
          const scale = hover ? 1 : 1 - depth * 0.05;
          return (
            <div
              key={t.id}
              className="toast"
              data-tone={t.tone}
              role={t.tone === "error" ? "alert" : "status"}
              style={{ transform: `translateY(${y}px) scale(${scale})`, opacity: depth > 2 ? 0 : 1, zIndex: 10 - depth }}
            >
              <span className="toast-dot" />
              <div className="toast-body">
                <span className="toast-title">{t.title}</span>
                {t.body && <span className="muted">{t.body}</span>}
              </div>
              {t.action && (
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    t.action!.run();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button className="btn-icon btn" aria-label="Dismiss" onClick={() => dismiss(t.id)} style={{ width: 24, height: 24 }}>
                ×
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
