import * as react_jsx_runtime from 'react/jsx-runtime';

interface MarkdownOptions {
    /** Protocols allowed for links. Default: ["https:", "http:", "mailto:"] */
    allowedProtocols?: string[];
    /** Link target attribute. Default: "_blank" */
    target?: "_blank" | "_self";
    /** Link rel attribute. Default: "noreferrer noopener" */
    rel?: string;
    /**
     * Optional class-name prefix added to every emitted element.
     * Example: `classPrefix: "md"` → `<h1 class="md-h1">`, `<p class="md-p">`, etc.
     *
     * When undefined (default), no classes are added — backward-compatible.
     */
    classPrefix?: string;
}
/**
 * Render markdown to a DocumentFragment without innerHTML or eval.
 * All links are validated via `new URL()` — javascript: and other unsafe
 * protocols render as plain text.
 *
 * @param text     Raw markdown string.
 * @param options  Link safety / target / rel overrides.
 * @param doc      Document to use for element creation. Defaults to globalThis.document.
 */
declare function renderMarkdown(text: string, options?: MarkdownOptions, doc?: Document): DocumentFragment;
/**
 * Render markdown directly into a container element.
 * Clears the container's existing content first.
 */
declare function renderMarkdownInto(text: string, container: Element, options?: MarkdownOptions): void;

type ThemePref = "auto" | "light" | "dark";
/** Set the base path for BlockBrain logo SVGs. Default: "icons/". */
declare function configureLogo(basePath: string): void;
/**
 * Apply a theme preference to the document.
 * Sets `document.documentElement.dataset.theme` and swaps `img.logo` src.
 */
declare function applyTheme(pref: ThemePref): void;
/** Cycle to the next theme preference. Returns the new preference. */
declare function cycleTheme(current: ThemePref): ThemePref;
/** Return the SVG icon markup for the given theme preference (Heroicons outline). */
declare function themeIcon(pref: ThemePref): string;

/** Format a Unix timestamp (ms) as a human-readable relative time string. */
declare function timeAgo(ts: number): string;

/** What the user has explicitly chosen. "auto" = follow OS preference. */
type ThemeMode = "light" | "dark" | "auto";
/** The effective theme applied to the document — always resolved. */
type Theme = "light" | "dark";
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
declare function useTheme(storageKey?: string): [Theme, ThemeMode, () => void];

interface ThemeToggleProps {
    /** Effective (resolved) theme — drives login-variant colour logic. */
    theme: Theme;
    /** User's explicit preference — drives which icon is shown. */
    mode: ThemeMode;
    /** Called when the user clicks the toggle button. */
    onToggle: () => void;
    /**
     * Visual context.
     * - "header" (default): dark sticky header — neutral-700 bg, white text, w-9 h-9.
     * - "login": gradient entry screen — adapts to light/dark, w-8 h-8.
     */
    variant?: "header" | "login";
}
/**
 * 3-state theme toggle button.
 *
 * light → dark → auto → light → …
 *
 * Renders Sun / Moon / Monitor icons (SVG, no emoji).
 * Pair with `useTheme` from `@theblockbrain/bb-client-sdk/ui`.
 */
declare function ThemeToggle({ theme, mode, onToggle, variant, }: ThemeToggleProps): react_jsx_runtime.JSX.Element;

export { type MarkdownOptions, type Theme, type ThemeMode, type ThemePref, ThemeToggle, type ThemeToggleProps, applyTheme, configureLogo, cycleTheme, renderMarkdown, renderMarkdownInto, themeIcon, timeAgo, useTheme };
