// Framework-agnostic UI helpers. Deliberately React-free: `bb-slack-integrations`
// (Node) and blocky-chat (Lit) reach this layer. `useTheme` used to be
// re-exported here, which made `.` and `./ui` unimportable without React
// (PDEV-7724) — the hook now lives on `./ui/react`.
//
// `markdown.ts` touches the DOM, but never at module scope, so it imports fine
// under bare Node. DOM-dependent is not React-dependent.
export type {
  MarkdownDocument,
  MarkdownElement,
  MarkdownFragment,
  MarkdownNode,
  MarkdownOptions,
} from "./markdown.js";
export { markdownToHtml, renderMarkdown, renderMarkdownInto } from "./markdown.js";
export type { Theme, ThemeMode } from "./theme-mode.js";
export { nextThemeMode } from "./theme-mode.js";
export { timeAgo } from "./time.js";
