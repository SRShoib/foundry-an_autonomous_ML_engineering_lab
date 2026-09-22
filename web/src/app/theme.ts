export type Theme = "dark" | "light";

/** Mirrored by the inline script in index.html, which applies it before first paint so a stored
 * light preference never flashes dark. Keep the two in sync. */
export const THEME_STORAGE_KEY = "foundry.theme";

/** Storage can throw — private windows, blocked site data, a sandboxed preview — and the console
 * must render correctly without it. It only ever holds a per-viewer convenience. */
export function readStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // not persisted; the choice still applies for this session
  }
}

/** Dark is primary (docs/design-plan.md §3), so the system preference is consulted only when the
 * viewer has not chosen. */
export function systemTheme(): Theme {
  const light = window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
  return light ? "light" : "dark";
}

export function currentTheme(): Theme {
  const applied = document.documentElement.getAttribute("data-theme");
  if (applied === "light" || applied === "dark") return applied;
  return readStoredTheme() ?? systemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}
