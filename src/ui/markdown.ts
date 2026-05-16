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
        parent.appendChild(doc.createTextNode(t.text));
      }
      break;
    }
    case "strong": {
      const el = doc.createElement("strong");
      appendInlineTokens(el, (token as Tokens.Strong).tokens ?? [], opts, doc);
      parent.appendChild(el);
      break;
    }
    case "em": {
      const el = doc.createElement("em");
      appendInlineTokens(el, (token as Tokens.Em).tokens ?? [], opts, doc);
      parent.appendChild(el);
      break;
    }
    case "del": {
      const el = doc.createElement("del");
      appendInlineTokens(el, (token as Tokens.Del).tokens ?? [], opts, doc);
      parent.appendChild(el);
      break;
    }
    case "codespan": {
      const el = doc.createElement("code");
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
      parent.appendChild(doc.createTextNode((token as Tokens.Escape).text));
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
      const tag = (`h${Math.min(6, Math.max(1, ht.depth))}` as keyof HTMLElementTagNameMap);
      const el = doc.createElement(tag);
      appendInlineTokens(el, ht.tokens ?? [], opts, doc);
      parent.appendChild(el);
      break;
    }
    case "paragraph": {
      const pt = token as Tokens.Paragraph;
      const p = doc.createElement("p");
      appendInlineTokens(p, pt.tokens ?? [], opts, doc);
      parent.appendChild(p);
      break;
    }
    case "code": {
      const ct = token as Tokens.Code;
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      if (ct.lang) code.setAttribute("class", `language-${ct.lang}`);
      code.textContent = ct.text;
      pre.appendChild(code);
      parent.appendChild(pre);
      break;
    }
    case "blockquote": {
      const bq = doc.createElement("blockquote");
      appendBlockTokens(bq, (token as Tokens.Blockquote).tokens ?? [], opts, doc);
      parent.appendChild(bq);
      break;
    }
    case "list": {
      const lt = token as Tokens.List;
      const list = doc.createElement(lt.ordered ? "ol" : "ul");
      for (const item of lt.items) {
        const li = doc.createElement("li");
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

      const thead = doc.createElement("thead");
      const headerRow = doc.createElement("tr");
      for (const cell of tt.header) {
        const th = doc.createElement("th");
        if (cell.align) th.setAttribute("style", `text-align:${cell.align}`);
        appendInlineTokens(th, cell.tokens ?? [], opts, doc);
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = doc.createElement("tbody");
      for (const row of tt.rows) {
        const tr = doc.createElement("tr");
        for (let i = 0; i < row.length; i++) {
          const cell = row[i];
          const td = doc.createElement("td");
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
      parent.appendChild(doc.createElement("hr"));
      break;
    }
    case "space": {
      // whitespace between blocks — skip
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
