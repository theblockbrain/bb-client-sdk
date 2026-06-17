import { marked } from "marked";
import type { Token, Tokens } from "marked";

// Enable GFM (tables, strikethrough) globally — idempotent, safe to call multiple times
marked.use({ gfm: true });

const DEFAULT_ALLOWED_PROTOCOLS = ["https:", "http:", "mailto:"];

export interface MarkdownOptions {
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Decode the small set of HTML entities that marked emits in `escape.text`
 * (e.g. `\&` → text `&amp;`). Uses a static map — never innerHTML — so it is
 * XSS-safe. Result is passed to createTextNode which re-escapes on insertion.
 */
const MARKED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

const MARKED_ENTITY_RE = /&(?:amp|lt|gt|quot|#39|apos);/g;

function decodeMarkedEntity(s: string): string {
  return s.replace(MARKED_ENTITY_RE, (m) => MARKED_ENTITIES[m] ?? m);
}

function cls(opts: Required<MarkdownOptions>, suffix: string): string {
  return opts.classPrefix ? opts.classPrefix + suffix : "";
}

function setClass(el: HTMLElement, className: string): void {
  if (className) el.className = className;
}

// ─── Inline walker ────────────────────────────────────────────────────────────

function appendInlineTokens(
  parent: Node,
  tokens: Token[],
  opts: Required<MarkdownOptions>,
  doc: Document,
): void {
  for (const token of tokens) {
    appendInlineToken(parent, token, opts, doc);
  }
}

function appendInlineToken(
  parent: Node,
  token: Token,
  opts: Required<MarkdownOptions>,
  doc: Document,
): void {
  switch (token.type) {
    case "text": {
      // text tokens may have nested tokens (e.g. bold inside a list item)
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) {
        appendInlineTokens(parent, t.tokens, opts, doc);
      } else {
        // Use t.raw instead of t.text: marked HTML-escapes t.text (& → &amp;, ' → &#39;, etc.)
        // but createTextNode treats the string as literal text, not HTML — entities would show
        // verbatim. t.raw is the original unescaped source for leaf text nodes.
        parent.appendChild(doc.createTextNode(t.raw));
      }
      break;
    }
    case "strong": {
      const el = doc.createElement("strong");
      setClass(el, cls(opts, "-strong"));
      appendInlineTokens(el, (token as Tokens.Strong).tokens ?? [], opts, doc);
      parent.appendChild(el);
      break;
    }
    case "em": {
      const el = doc.createElement("em");
      setClass(el, cls(opts, "-em"));
      appendInlineTokens(el, (token as Tokens.Em).tokens ?? [], opts, doc);
      parent.appendChild(el);
      break;
    }
    case "del": {
      const el = doc.createElement("del");
      setClass(el, cls(opts, "-del"));
      appendInlineTokens(el, (token as Tokens.Del).tokens ?? [], opts, doc);
      parent.appendChild(el);
      break;
    }
    case "codespan": {
      const el = doc.createElement("code");
      setClass(el, cls(opts, "-code"));
      el.textContent = (token as Tokens.Codespan).text;
      parent.appendChild(el);
      break;
    }
    case "link": {
      const lt = token as Tokens.Link;
      const href = lt.href ?? "";
      let safe = false;
      try {
        const parsed = new URL(href);
        safe = opts.allowedProtocols.includes(parsed.protocol);
      } catch {
        // relative or invalid URL — render as plain text
      }
      if (safe) {
        const a = doc.createElement("a");
        setClass(a, cls(opts, "-link"));
        a.setAttribute("href", href);
        if (opts.target) a.setAttribute("target", opts.target);
        if (opts.rel) a.setAttribute("rel", opts.rel);
        appendInlineTokens(a, lt.tokens ?? [], opts, doc);
        parent.appendChild(a);
      } else {
        // XSS-safe fallback: render link text as plain text, drop href entirely
        appendInlineTokens(parent, lt.tokens ?? [], opts, doc);
      }
      break;
    }
    case "image": {
      // Images skipped for safety — render alt text as plain text
      const it = token as Tokens.Image;
      if (it.text) parent.appendChild(doc.createTextNode(it.text));
      break;
    }
    case "br": {
      parent.appendChild(doc.createElement("br"));
      break;
    }
    case "escape": {
      // marked HTML-escapes escape.text (\& → "&amp;", \< → "&lt;", etc.).
      // raw contains the backslash ("\&") — not what we want either.
      // Decode the entity back to the literal char before createTextNode.
      parent.appendChild(doc.createTextNode(decodeMarkedEntity((token as Tokens.Escape).text)));
      break;
    }
    default: {
      // Unknown inline token — emit raw text if available
      const raw = (token as { raw?: string }).raw;
      if (raw) parent.appendChild(doc.createTextNode(raw));
      break;
    }
  }
}

// ─── Block walker ─────────────────────────────────────────────────────────────

function appendBlockTokens(
  parent: Node,
  tokens: Token[],
  opts: Required<MarkdownOptions>,
  doc: Document,
): void {
  for (const token of tokens) {
    appendBlockToken(parent, token, opts, doc);
  }
}

function appendBlockToken(
  parent: Node,
  token: Token,
  opts: Required<MarkdownOptions>,
  doc: Document,
): void {
  switch (token.type) {
    case "heading": {
      const ht = token as Tokens.Heading;
      const depth = Math.min(6, Math.max(1, ht.depth));
      const tag = `h${depth}` as keyof HTMLElementTagNameMap;
      const el = doc.createElement(tag);
      setClass(el, cls(opts, `-h${depth}`));
      appendInlineTokens(el, ht.tokens ?? [], opts, doc);
      parent.appendChild(el);
      break;
    }
    case "paragraph": {
      const pt = token as Tokens.Paragraph;
      const p = doc.createElement("p");
      setClass(p, cls(opts, "-p"));
      appendInlineTokens(p, pt.tokens ?? [], opts, doc);
      parent.appendChild(p);
      break;
    }
    case "code": {
      const ct = token as Tokens.Code;
      const pre = doc.createElement("pre");
      setClass(pre, cls(opts, "-pre"));
      const code = doc.createElement("code");
      // Combine prefix class and language class so syntax highlighters still work
      // alongside Tailwind class-targeting. Only set the attribute when non-empty.
      const combined = [cls(opts, "-pre-code"), ct.lang ? `language-${ct.lang}` : ""]
        .filter(Boolean)
        .join(" ");
      if (combined) code.setAttribute("class", combined);
      code.textContent = ct.text;
      pre.appendChild(code);
      parent.appendChild(pre);
      break;
    }
    case "blockquote": {
      const bq = doc.createElement("blockquote");
      setClass(bq, cls(opts, "-quote"));
      appendBlockTokens(bq, (token as Tokens.Blockquote).tokens ?? [], opts, doc);
      parent.appendChild(bq);
      break;
    }
    case "list": {
      const lt = token as Tokens.List;
      const list = doc.createElement(lt.ordered ? "ol" : "ul");
      setClass(list, cls(opts, lt.ordered ? "-ol" : "-ul"));
      for (const item of lt.items) {
        const li = doc.createElement("li");
        setClass(li, cls(opts, "-li"));
        // List items may contain block-level tokens (nested lists, paragraphs)
        if (item.tokens && item.tokens.length > 0) {
          appendBlockTokens(li, item.tokens, opts, doc);
        } else {
          li.textContent = item.text;
        }
        list.appendChild(li);
      }
      parent.appendChild(list);
      break;
    }
    case "table": {
      const tt = token as Tokens.Table;
      const table = doc.createElement("table");
      setClass(table, cls(opts, "-table"));

      const thead = doc.createElement("thead");
      setClass(thead, cls(opts, "-thead"));
      const headerRow = doc.createElement("tr");
      setClass(headerRow, cls(opts, "-tr"));
      for (const cell of tt.header) {
        const th = doc.createElement("th");
        setClass(th, cls(opts, "-th"));
        if (cell.align) th.setAttribute("style", `text-align:${cell.align}`);
        appendInlineTokens(th, cell.tokens ?? [], opts, doc);
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = doc.createElement("tbody");
      setClass(tbody, cls(opts, "-tbody"));
      for (const row of tt.rows) {
        const tr = doc.createElement("tr");
        setClass(tr, cls(opts, "-tr"));
        for (let i = 0; i < row.length; i++) {
          const cell = row[i];
          const td = doc.createElement("td");
          setClass(td, cls(opts, "-td"));
          const align = tt.header[i]?.align;
          if (align) td.setAttribute("style", `text-align:${align}`);
          appendInlineTokens(td, cell.tokens ?? [], opts, doc);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      parent.appendChild(table);
      break;
    }
    case "hr": {
      const hr = doc.createElement("hr");
      setClass(hr, cls(opts, "-hr"));
      parent.appendChild(hr);
      break;
    }
    case "space": {
      // whitespace between blocks — skip
      break;
    }
    case "text": {
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) {
        appendInlineTokens(parent, t.tokens, opts, doc);
      } else {
        // Same as inline case: use t.raw to avoid rendering marked's HTML-escaped t.text
        // verbatim through createTextNode.
        parent.appendChild(doc.createTextNode(t.raw));
      }
      break;
    }
    case "html": {
      // Raw HTML blocks are dropped for XSS safety — render raw text
      const raw = (token as Tokens.HTML).raw;
      if (raw) parent.appendChild(doc.createTextNode(raw));
      break;
    }
    default: {
      // Unknown block token — emit raw if available
      const raw = (token as { raw?: string }).raw;
      if (raw) parent.appendChild(doc.createTextNode(raw));
      break;
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render markdown to a DocumentFragment without innerHTML or eval.
 * All links are validated via `new URL()` — javascript: and other unsafe
 * protocols render as plain text.
 *
 * @param text     Raw markdown string.
 * @param options  Link safety / target / rel overrides.
 * @param doc      Document to use for element creation. Defaults to globalThis.document.
 */
export function renderMarkdown(
  text: string,
  options?: MarkdownOptions,
  doc: Document = document,
): DocumentFragment {
  const opts: Required<MarkdownOptions> = {
    allowedProtocols: options?.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS,
    target: options?.target ?? "_blank",
    rel: options?.rel ?? "noreferrer noopener",
    classPrefix: options?.classPrefix ?? "",
  };

  const tokens = marked.lexer(text);
  const fragment = doc.createDocumentFragment();
  appendBlockTokens(fragment, tokens, opts, doc);
  return fragment;
}

/**
 * Render markdown directly into a container element.
 * Clears the container's existing content first.
 */
export function renderMarkdownInto(
  text: string,
  container: Element,
  options?: MarkdownOptions,
): void {
  // Use ownerDocument so this works in iframes and JSDOM
  const doc = container.ownerDocument ?? document;
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(renderMarkdown(text, options, doc));
}

/**
 * Render markdown to an HTML string.
 *
 * Builds on `renderMarkdown` (safe DOM construction via createTextNode/createElement,
 * no innerHTML parsing of raw input) and serialises the resulting fragment to HTML.
 * The serialisation step (`container.innerHTML`) is safe here — we read the property
 * of a DOM we constructed ourselves, not parsing attacker-controlled HTML.
 *
 * Requires a browser/DOM context (`document` global must be available).
 *
 * @param text     Raw markdown string.
 * @param options  Link safety / target / rel / classPrefix overrides.
 * @param doc      Document for element creation. Defaults to globalThis.document.
 */
export function markdownToHtml(
  text: string,
  options?: MarkdownOptions,
  doc: Document = document,
): string {
  const container = doc.createElement("div");
  container.appendChild(renderMarkdown(text, options, doc));
  return container.innerHTML;
}
