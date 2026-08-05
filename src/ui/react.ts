// React-dependent slice of `./ui` (PDEV-7724). `useTheme` is the only symbol
// here because it is the only one that imports React; the vocabulary it operates
// on stays on `./ui` via `theme-mode.ts`.
export type { Theme, ThemeMode } from "./theme-mode.js";
export { useTheme } from "./useTheme.js";
