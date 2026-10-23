export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "scream-bot-theme";
const QUERY = "(prefers-color-scheme: dark)";

export function readTheme(): Theme {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : "system";
}

export function applyTheme(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia(QUERY).matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function writeTheme(theme: Theme): void {
  window.localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

/** Applies the stored theme before the first paint and follows the system when asked to. */
export function installTheme(): () => void {
  applyTheme(readTheme());
  const media = window.matchMedia(QUERY);
  const onChange = () => {
    if (readTheme() === "system") applyTheme("system");
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
