import { useCallback, useEffect, useState } from "react";

/**
 * What the user has explicitly chosen.
 *
 * `system` is a real, persisted value — **not** a placeholder the SDK resolves
 * away. It is written to `data-theme` verbatim, because `@botticelli/blokkit`
 * resolves it in CSS:
 *
 * ```css
 * &:where([data-theme="system"] *, [data-theme="system"]) {
 *   @media (prefers-color-scheme: dark) { … }
 * }
 * ```
 *
 * Resolving it in JS instead would write `dark` or `light` and blokkit's
 * `system` branch would never match — which is the bug this replaces.
 */
export type ThemeMode = "light" | "dark" | "system";

/** The effective theme, resolved for JS consumers that must branch on it. */
export type Theme = "light" | "dark";

const DEFAULT_STORAGE_KEY = "bb-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Cycle order: light → dark → system → light → …
 *
 * Exported as a pure function so a surface can build its own toggle without
 * re-deriving the order. The SDK deliberately ships no toggle component: one
 * styled in default Tailwind palette classes breaks under blokkit's
 * `tailwind-reset.css`, which sets `--color-*: initial`.
 */
export function nextThemeMode(current: ThemeMode): ThemeMode {
  if (current === "light") return "dark";
  if (current === "dark") return "system";
  return "light";
}

function prefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

function readStoredMode(storageKey: string): ThemeMode {
  const stored = localStorage.getItem(storageKey);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/**
 * Persist the preference. `system` is stored as *absence* — it is the default,
 * and writing it would make "never chose" and "chose system" indistinguishable
 * from a later migration's point of view.
 */
function persistMode(storageKey: string, mode: ThemeMode): void {
  if (mode === "system") {
    localStorage.removeItem(storageKey);
    return;
  }
  localStorage.setItem(storageKey, mode);
}

/**
 * The SDK's single theme mechanism: `<html data-theme="light|dark|system">`.
 *
 * Returns `[effectiveTheme, themeMode, cycleTheme]`:
 * - `effectiveTheme` — `light` | `dark`, with `system` already resolved against
 *   the OS. For JS branching only; CSS should key on `data-theme` and let the
 *   media query do the work.
 * - `themeMode` — the user's explicit setting, including `system`.
 * - `cycleTheme` — advances light → dark → system → light.
 *
 * Before PDEV-7000 the SDK shipped two contradictory activations: `applyTheme`
 * wrote `data-theme` while this hook toggled `<html class="dark">`, and
 * `theme-base.css` declared an `@custom-variant dark` keyed on `.dark` that
 * collided with blokkit's identically-named variant keyed on `[data-theme]`.
 * `packages/v1-frontend` paid for that with `attribute={['class','data-theme']}`.
 * There is now exactly one.
 *
 * Host-provided themes (Office's `Office.context.officeTheme` +
 * `OfficeThemeChanged`) stay adapter-side: a surface detects the host theme and
 * feeds this mechanism, rather than the SDK reaching for a host API it cannot
 * assume exists.
 *
 * @param storageKey  localStorage key for the preference. Pass a per-tool key
 *   (e.g. `"bb-dashboard-theme"`) when several tools share an origin.
 */
export function useTheme(storageKey: string = DEFAULT_STORAGE_KEY): [Theme, ThemeMode, () => void] {
  const [mode, setMode] = useState<ThemeMode>(() => readStoredMode(storageKey));
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);

  // Derived, not a third piece of state — the previous implementation kept
  // `theme` in its own useState and had to remember to update it in four
  // places, which is how the two mechanisms drifted apart to begin with.
  const theme: Theme = mode === "system" ? (systemDark ? "dark" : "light") : mode;

  // Write the preference verbatim. Depending on `mode` covers both the initial
  // mount and every later change, so no one-shot mount effect (and no lint
  // suppression for its empty dependency list) is needed.
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  // Track the OS preference **unconditionally**, including while `mode` is an
  // explicit light/dark. It looks wasteful — `theme` ignores `systemDark` in
  // those modes — but skipping it leaves a stale value: flip the OS while in
  // explicit light, then switch to `system`, and the hook would report light
  // against a dark OS until the next flip. One re-render per OS theme change is
  // the cheaper side of that trade.
  //
  // The DOM is not touched here either way: `data-theme` still reads `system`,
  // and the media query inside the CSS variant does the switching.
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const handleChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  // Persist as an effect on `mode`, not inside `cycleTheme`.
  //
  // Two constraints pull against each other here. Writing inside a
  // `setMode(prev => …)` updater is impure, and React double-invokes updaters in
  // StrictMode, so the write fires twice per click. But computing `next` from a
  // closed-over `mode` goes stale: two `cycleTheme()` calls in one tick both
  // read the same `mode`, so a double click advances one step instead of two.
  //
  // Splitting them satisfies both — the updater is pure and reads the live
  // previous value, and the write happens once per committed change. It also
  // runs on mount, which is a no-op: it rewrites the value just read from
  // storage, or removes a key that was already absent for `system`.
  useEffect(() => {
    persistMode(storageKey, mode);
  }, [mode, storageKey]);

  const cycleTheme = useCallback(() => {
    setMode(nextThemeMode);
  }, []);

  return [theme, mode, cycleTheme];
}
