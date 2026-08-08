import { useCallback, useEffect, useMemo, useState } from "react";
import type { SyncStorageAdapter } from "../adapters/storage.js";
import { createWebStorageAdapter } from "../adapters/web-storage.js";
import type { Theme, ThemeMode } from "./theme-mode.js";
import { DARK_QUERY, DEFAULT_STORAGE_KEY, nextThemeMode } from "./theme-mode.js";

function prefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

function readStoredMode(storage: SyncStorageAdapter, storageKey: string): ThemeMode {
  const stored = storage.get(storageKey);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/**
 * Persist the preference. `system` is stored as *absence* — it is the default,
 * and writing it would make "never chose" and "chose system" indistinguishable
 * from a later migration's point of view.
 */
function persistMode(storage: SyncStorageAdapter, storageKey: string, mode: ThemeMode): void {
  if (mode === "system") {
    storage.remove(storageKey);
    return;
  }
  storage.set(storageKey, mode);
}

/** Inputs to {@link useTheme}, as an alternative to the positional call form. */
export interface UseThemeOptions {
  /**
   * localStorage key for the preference. Pass a per-tool key (e.g.
   * `"bb-dashboard-theme"`) when several tools share an origin.
   *
   * Default: {@link DEFAULT_STORAGE_KEY}.
   */
  storageKey?: string;
  /**
   * Where the preference is held. Defaults to `localStorage`, dereferenced inside
   * the hook rather than at module scope so importing this module stays safe in a
   * runtime without Web Storage. A host that has none supplies its own adapter,
   * which is the whole point of the port.
   */
  storage?: SyncStorageAdapter;
  /**
   * The theme of the surrounding host application, already resolved to
   * `light` or `dark` by the surface.
   *
   * Used only while `mode` is `system`, and only for the *resolution* of
   * `system`: it never overrides an explicit light or dark choice. Precedence is
   * explicit mode, then this, then `prefers-color-scheme`. Pass `null` or
   * `undefined` while the host theme is unknown (before `Office.onReady` settles,
   * for instance) and the media query resolves `system` as it always has.
   *
   * **Detection stays adapter-side, and this is an INPUT only.** The SDK takes no
   * dependency on `@types/office-js`, so it will never read
   * `Office.context.officeTheme` or subscribe to `OfficeThemeChanged` itself. A
   * surface detects the host theme, keeps it in its own state, and feeds it here.
   *
   * Supplying it also mirrors the value onto `<html data-host-theme>`, so CSS can
   * key on it. `data-theme` is left carrying `mode` verbatim, `system` included:
   * folding the host into that attribute would resolve `system` away and kill
   * blokkit's `@media (prefers-color-scheme: dark)` branch (PDEV-7000). With both
   * attributes a stylesheet expresses the full precedence itself:
   *
   * ```css
   * [data-theme="dark"]                             --> explicit choice
   * [data-theme="system"][data-host-theme="dark"]    --> the host, when known
   * [data-theme="system"]:not([data-host-theme])     --> + @media, i.e. the OS
   * ```
   *
   * Going back to `null` REMOVES the attribute rather than writing a value, which
   * is what re-arms that third branch.
   *
   * Why the input exists (PDEV-7369): resolving `system` from the OS is wrong in an
   * Office task pane, because Word carries its own theme setting that has nothing
   * to do with `prefers-color-scheme`. A consumer branching on the returned `theme`
   * to pick a light or dark asset then picks the wrong one for the background it is
   * sitting on. `ms-word-addin` had to re-resolve `theme` in a wrapper around this
   * hook, which is a workaround the next Office adopter should not have to repeat.
   */
  hostTheme?: Theme | null;
}

/**
 * What {@link useTheme} returns. Deliberately unexported: it is a positional
 * tuple, and `ReturnType<typeof useTheme>` names it for a wrapper without adding
 * another symbol to the public surface. New elements are only ever APPENDED, so
 * `const [theme, mode, cycle] = useTheme()` keeps compiling.
 */
type UseThemeResult = [
  theme: Theme,
  mode: ThemeMode,
  cycleTheme: () => void,
  setMode: (mode: ThemeMode) => void,
];

/**
 * The SDK's single theme mechanism: `<html data-theme="light|dark|system">`.
 *
 * Returns `[effectiveTheme, themeMode, cycleTheme, setMode]`:
 * - `effectiveTheme` — `light` | `dark`, with `system` already resolved. For JS
 *   branching only (picking an asset, say). CSS should key on `data-theme` and let
 *   the media query do the work.
 * - `themeMode` — the user's explicit setting, including `system`.
 * - `cycleTheme` — advances light, dark, system, light.
 * - `setMode` — sets a mode directly, for a surface with three explicit controls.
 *   Same state and persistence path as `cycleTheme`, and equally stable across
 *   renders. It exists because `ms-word-addin` had a Light / Dark / System button
 *   trio and had to collapse it into one cycling control to adopt this hook
 *   (PDEV-7369). A cycle is not a superset of a setter.
 *
 * Two call forms, both supported, the positional one for backward compatibility:
 *
 * ```ts
 * const [theme, mode, cycle, setMode] = useTheme();                     // defaults
 * const [theme, mode, cycle, setMode] = useTheme("bb-dashboard-theme"); // positional
 * const [theme, mode, cycle, setMode] = useTheme({ hostTheme });        // named
 * ```
 *
 * `hostTheme` is reachable only through the object form on purpose. As a third
 * positional it would read `useTheme(undefined, undefined, hostTheme)` in the
 * common Office case, and because it is a bare `"light"` / `"dark"` string a
 * caller who wrote `useTheme(hostTheme)` would silently key the preference under
 * `"dark"` with no type error. See {@link UseThemeOptions}.
 *
 * Before PDEV-7000 the SDK shipped two contradictory activations: `applyTheme`
 * wrote `data-theme` while this hook toggled `<html class="dark">`, and
 * `theme-base.css` declared an `@custom-variant dark` keyed on `.dark` that
 * collided with blokkit's identically-named variant keyed on `[data-theme]`.
 * `packages/v1-frontend` paid for that with `attribute={['class','data-theme']}`.
 * There is now exactly one.
 */
export function useTheme(options?: UseThemeOptions): UseThemeResult;
export function useTheme(storageKey?: string, storage?: SyncStorageAdapter): UseThemeResult;
export function useTheme(
  optionsOrStorageKey?: UseThemeOptions | string,
  positionalStorage?: SyncStorageAdapter,
): UseThemeResult {
  // Normalise the two call forms before any hook runs, so the hook order below is
  // identical whichever form the caller used. Allocating a wrapper object per
  // render is safe because only the primitives and the adapter REFERENCE pulled
  // out of it reach a dependency array, never the wrapper itself: the object form
  // is written inline at the call site (`useTheme({ hostTheme })`), so a wrapper
  // in a dep array would re-run the persist effect, and re-write storage, on
  // every single render.
  const options: UseThemeOptions =
    typeof optionsOrStorageKey === "string"
      ? { storageKey: optionsOrStorageKey, storage: positionalStorage }
      : (optionsOrStorageKey ?? { storage: positionalStorage });
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const injectedStorage = options.storage;
  const hostTheme = options.hostTheme ?? null;

  // Memoised on the caller's adapter, not created per render: the persist effect
  // depends on it, and a fresh object each render would re-run that effect (and
  // so re-write storage) on every render.
  //
  // `localStorage` is dereferenced here rather than at module scope, so importing
  // this module stays safe in a runtime without it (invariant B). A host without
  // Web Storage passes its own adapter — which is the point of the port.
  const store = useMemo(
    () => injectedStorage ?? createWebStorageAdapter(localStorage),
    [injectedStorage],
  );

  const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode(store, storageKey));
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);

  // Derived, not a third piece of state — the previous implementation kept
  // `theme` in its own useState and had to remember to update it in four
  // places, which is how the two mechanisms drifted apart to begin with.
  //
  // Precedence: explicit mode, then the host theme, then the OS. An explicit
  // choice is the user overriding both, so it wins outright.
  const theme: Theme = mode !== "system" ? mode : (hostTheme ?? (systemDark ? "dark" : "light"));

  // `data-theme` carries `mode` VERBATIM, `system` included. That is a contract,
  // not an implementation detail: `@botticelli/blokkit` resolves `system` in CSS
  // through its own `@media (prefers-color-scheme: dark)` branch, so writing a
  // resolved `dark`/`light` there makes that branch dead code and dark mode
  // silently stops following the OS. This is the bug PDEV-7000 fixed, which is
  // why `theme-mode.ts` documents `system` as a real persisted value rather than
  // a placeholder to be resolved away.
  //
  // The host theme therefore gets its OWN attribute rather than being folded into
  // this one. CSS has no `@media (office-theme: dark)` and cannot see the host, so
  // it does need a hook, but resolving into `data-theme` to provide one would
  // trade this bug for that one. Two attributes let a stylesheet express the full
  // precedence itself:
  //
  //   [data-theme="dark"]                                 explicit choice
  //   [data-theme="system"][data-host-theme="dark"]        host, when it told us
  //   [data-theme="system"]:not([data-host-theme])         + @media, i.e. the OS
  //
  // Absent `hostTheme` the attribute is never written, so a caller that does not
  // pass one sees byte-identical DOM to before.
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  // Separate effect from the one above, because the two have different lifetimes:
  // `mode` is always present while `hostTheme` may arrive late, disappear, or
  // never come at all. Removing the attribute rather than writing a value when it
  // goes away is what hands resolution back to the media query.
  useEffect(() => {
    const root = document.documentElement;
    if (hostTheme === null) {
      delete root.dataset.hostTheme;
      return;
    }
    root.dataset.hostTheme = hostTheme;
  }, [hostTheme]);

  // Track the OS preference **unconditionally**, including while `mode` is an
  // explicit light/dark, and including while a `hostTheme` is supplied. It looks
  // wasteful — `theme` ignores `systemDark` in those cases — but skipping it
  // leaves a stale value: flip the OS while in explicit light, then switch to
  // `system`, and the hook would report light against a dark OS until the next
  // flip. Same for a `hostTheme` that goes back to `null`. One re-render per OS
  // theme change is the cheaper side of that trade.
  //
  // The DOM is not touched from here: `data-theme` still reads `system` and the
  // media query inside the CSS variant does the switching.
  useEffect(() => {
    const query = window.matchMedia(DARK_QUERY);
    const handleChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  // Persist as an effect on `mode`, not inside `cycleTheme` / `setMode`.
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
  //
  // Being an effect on the committed `mode` is also why the exposed `setMode`
  // gets the same persistence semantics as `cycleTheme` for free, rather than
  // needing its own write that could drift.
  useEffect(() => {
    persistMode(store, storageKey, mode);
  }, [store, mode, storageKey]);

  const cycleTheme = useCallback(() => {
    setModeState(nextThemeMode);
  }, []);

  // Wrapped rather than handing back React's `Dispatch` directly. `Dispatch`
  // also accepts an updater function, and exposing that would widen the public
  // contract to something the doc comment does not describe. The empty dependency
  // list keeps the identity stable across renders, so a consumer can pass it to a
  // memoised child the same way it passes `cycleTheme`.
  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
  }, []);

  return [theme, mode, cycleTheme, setMode];
}
