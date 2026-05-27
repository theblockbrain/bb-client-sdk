import { useCallback, useEffect, useState } from "react";

/** What the user has explicitly chosen. "auto" = follow OS preference. */
export type ThemeMode = "light" | "dark" | "auto";

/** The effective theme applied to the document — always resolved. */
export type Theme = "light" | "dark";

const DEFAULT_STORAGE_KEY = "bb-theme";

function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readStoredMode(storageKey: string): ThemeMode {
  const stored = localStorage.getItem(storageKey);
  if (stored === "light" || stored === "dark") return stored;
  return "auto";
}

function resolveTheme(mode: ThemeMode): Theme {
  if (mode === "auto") return getSystemTheme();
  return mode;
}

function applyClassTheme(theme: Theme): void {
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

/**
 * Canonical 3-state theme hook (class-strategy: `<html class="dark">`).
 *
 * Returns [effectiveTheme, themeMode, cycleTheme]:
 * - effectiveTheme: "light" | "dark" — what is applied to the DOM.
 * - themeMode: "light" | "dark" | "auto" — the user's explicit setting.
 * - cycleTheme: cycles light → dark → auto → light → …
 *
 * @param storageKey  localStorage key for persisting the preference.
 *   Pass a per-tool key (e.g. "bb-dashboard-theme") to avoid collisions
 *   when multiple tools share the same origin. Default: "bb-theme".
 */
export function useTheme(
  storageKey: string = DEFAULT_STORAGE_KEY,
): [Theme, ThemeMode, () => void] {
  const [mode, setModeState] = useState<ThemeMode>(() =>
    readStoredMode(storageKey),
  );
  const [theme, setThemeState] = useState<Theme>(() =>
    resolveTheme(readStoredMode(storageKey)),
  );

  const cycleTheme = useCallback(() => {
    setModeState((prev) => {
      const next: ThemeMode =
        prev === "light" ? "dark" : prev === "dark" ? "auto" : "light";
      if (next === "auto") {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, next);
      }
      const resolved = resolveTheme(next);
      applyClassTheme(resolved);
      setThemeState(resolved);
      return next;
    });
  }, [storageKey]);

  // Sync DOM on initial mount
  useEffect(() => {
    applyClassTheme(theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot
  }, []);

  // OS preference change — only active when mode === "auto"
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    function handleChange(e: MediaQueryListEvent) {
      setModeState((currentMode) => {
        if (currentMode === "auto") {
          const resolved: Theme = e.matches ? "dark" : "light";
          applyClassTheme(resolved);
          setThemeState(resolved);
        }
        return currentMode;
      });
    }
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, []);

  return [theme, mode, cycleTheme];
}
