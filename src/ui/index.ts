export { renderMarkdown, renderMarkdownInto, markdownToHtml } from "./markdown.js";
export type { MarkdownOptions } from "./markdown.js";

export { applyTheme, cycleTheme, themeIcon, configureLogo } from "./theme.js";
export type { ThemePref } from "./theme.js";

export { timeAgo } from "./time.js";

// ── React components & hooks (React 19 peer) ─────────────────────────────────
export { useTheme } from "./useTheme.js";
export type { Theme, ThemeMode } from "./useTheme.js";

export { ThemeToggle } from "./ThemeToggle.js";
export type { ThemeToggleProps } from "./ThemeToggle.js";
