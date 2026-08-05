// React-free half of the theme mechanism: the vocabulary and the cycle order.
//
// Split from `useTheme.ts` because re-exporting *anything* from a module that
// imports React pulls React into the graph — so `./ui` was unimportable without
// it even though `nextThemeMode` is pure (PDEV-7724).

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

export const DEFAULT_STORAGE_KEY = "bb-theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

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
