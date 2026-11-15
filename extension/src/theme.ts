/** Dark, light or the system's choice for the extension's own pages, remembered in this browser. */

export type Theme = "system" | "dark" | "light";
const KEY = "tailor-theme";

export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "dark" || t === "light" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(theme: Theme = savedTheme()): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/** Wire a button that cycles system → dark → light. */
export function themeButton(button: HTMLButtonElement): void {
  const label = (t: Theme) => ({ system: "Theme: system", dark: "Theme: dark", light: "Theme: light" })[t];
  let theme = savedTheme();
  button.textContent = label(theme);
  button.addEventListener("click", () => {
    theme = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Storage can be off; the choice then lasts for this page only.
    }
    applyTheme(theme);
    button.textContent = label(theme);
  });
}
