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

export { type MarkdownOptions, type ThemePref, applyTheme, configureLogo, cycleTheme, renderMarkdown, renderMarkdownInto, themeIcon, timeAgo };
