// src/ui/markdown.ts
import { marked } from "marked";
marked.use({ gfm: true });
var DEFAULT_ALLOWED_PROTOCOLS = ["https:", "http:", "mailto:"];
function cls(opts, suffix) {
  return opts.classPrefix ? opts.classPrefix + suffix : "";
}
function setClass(el, className) {
  if (className) el.className = className;
}
function appendInlineTokens(parent, tokens, opts, doc) {
  for (const token of tokens) {
    appendInlineToken(parent, token, opts, doc);
  }
}
function appendInlineToken(parent, token, opts, doc) {
  switch (token.type) {
    case "text": {
      const t = token;
      if (t.tokens && t.tokens.length > 0) {
        appendInlineTokens(parent, t.tokens, opts, doc);
      } else {
        parent.appendChild(doc.createTextNode(t.text));
      }
      break;
    }
    case "strong": {
      const el = doc.createElement("strong");
      setClass(el, cls(opts, "-strong"));
      appendInlineTokens(el, token.tokens ?? [], opts, doc);
      parent.appendChild(el);
      break;
    }
    case "em": {
      const el = doc.createElement("em");
      setClass(el, cls(opts, "-em"));
      appendInlineTokens(el, token.tokens ?? [], opts, doc);
      parent.appendChild(el);
      break;
    }
    case "del": {
      const el = doc.createElement("del");
      setClass(el, cls(opts, "-del"));
      appendInlineTokens(el, token.tokens ?? [], opts, doc);
      parent.appendChild(el);
      break;
    }
    case "codespan": {
      const el = doc.createElement("code");
      setClass(el, cls(opts, "-code"));
      el.textContent = token.text;
      parent.appendChild(el);
      break;
    }
    case "link": {
      const lt = token;
      const href = lt.href ?? "";
      let safe = false;
      try {
        const parsed = new URL(href);
        safe = opts.allowedProtocols.includes(parsed.protocol);
      } catch {
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
        appendInlineTokens(parent, lt.tokens ?? [], opts, doc);
      }
      break;
    }
    case "image": {
      const it = token;
      if (it.text) parent.appendChild(doc.createTextNode(it.text));
      break;
    }
    case "br": {
      parent.appendChild(doc.createElement("br"));
      break;
    }
    case "escape": {
      parent.appendChild(doc.createTextNode(token.text));
      break;
    }
    default: {
      const raw = token.raw;
      if (raw) parent.appendChild(doc.createTextNode(raw));
      break;
    }
  }
}
function appendBlockTokens(parent, tokens, opts, doc) {
  for (const token of tokens) {
    appendBlockToken(parent, token, opts, doc);
  }
}
function appendBlockToken(parent, token, opts, doc) {
  switch (token.type) {
    case "heading": {
      const ht = token;
      const depth = Math.min(6, Math.max(1, ht.depth));
      const tag = `h${depth}`;
      const el = doc.createElement(tag);
      setClass(el, cls(opts, `-h${depth}`));
      appendInlineTokens(el, ht.tokens ?? [], opts, doc);
      parent.appendChild(el);
      break;
    }
    case "paragraph": {
      const pt = token;
      const p = doc.createElement("p");
      setClass(p, cls(opts, "-p"));
      appendInlineTokens(p, pt.tokens ?? [], opts, doc);
      parent.appendChild(p);
      break;
    }
    case "code": {
      const ct = token;
      const pre = doc.createElement("pre");
      setClass(pre, cls(opts, "-pre"));
      const code = doc.createElement("code");
      const combined = [cls(opts, "-pre-code"), ct.lang ? `language-${ct.lang}` : ""].filter(Boolean).join(" ");
      if (combined) code.setAttribute("class", combined);
      code.textContent = ct.text;
      pre.appendChild(code);
      parent.appendChild(pre);
      break;
    }
    case "blockquote": {
      const bq = doc.createElement("blockquote");
      setClass(bq, cls(opts, "-quote"));
      appendBlockTokens(bq, token.tokens ?? [], opts, doc);
      parent.appendChild(bq);
      break;
    }
    case "list": {
      const lt = token;
      const list = doc.createElement(lt.ordered ? "ol" : "ul");
      setClass(list, cls(opts, lt.ordered ? "-ol" : "-ul"));
      for (const item of lt.items) {
        const li = doc.createElement("li");
        setClass(li, cls(opts, "-li"));
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
      const tt = token;
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
      break;
    }
    case "text": {
      const t = token;
      if (t.tokens && t.tokens.length > 0) {
        appendInlineTokens(parent, t.tokens, opts, doc);
      } else {
        parent.appendChild(doc.createTextNode(t.text));
      }
      break;
    }
    case "html": {
      const raw = token.raw;
      if (raw) parent.appendChild(doc.createTextNode(raw));
      break;
    }
    default: {
      const raw = token.raw;
      if (raw) parent.appendChild(doc.createTextNode(raw));
      break;
    }
  }
}
function renderMarkdown(text, options, doc = document) {
  const opts = {
    allowedProtocols: options?.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS,
    target: options?.target ?? "_blank",
    rel: options?.rel ?? "noreferrer noopener",
    classPrefix: options?.classPrefix ?? ""
  };
  const tokens = marked.lexer(text);
  const fragment = doc.createDocumentFragment();
  appendBlockTokens(fragment, tokens, opts, doc);
  return fragment;
}
function renderMarkdownInto(text, container, options) {
  const doc = container.ownerDocument ?? document;
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(renderMarkdown(text, options, doc));
}

// src/ui/theme.ts
var THEME_PREFS = ["auto", "light", "dark"];
var logoBasePath = "icons/";
function configureLogo(basePath) {
  logoBasePath = basePath;
}
function applyTheme(pref) {
  const dark = pref === "dark" || pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset["theme"] = dark ? "dark" : "light";
  document.querySelectorAll("img.logo").forEach((img) => {
    img.src = `${logoBasePath}blockbrain_logo_${dark ? "dark" : "light"}.svg`;
  });
}
function cycleTheme(current) {
  const idx = THEME_PREFS.indexOf(current);
  return THEME_PREFS[(idx + 1) % THEME_PREFS.length];
}
function themeIcon(pref) {
  if (pref === "light") {
    return `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16">
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
    </svg>`;
  }
  if (pref === "dark") {
    return `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16">
      <path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
    </svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16">
    <path stroke-linecap="round" stroke-linejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0H3" />
  </svg>`;
}

// src/ui/time.ts
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1e3);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export {
  renderMarkdown,
  renderMarkdownInto,
  configureLogo,
  applyTheme,
  cycleTheme,
  themeIcon,
  timeAgo
};
//# sourceMappingURL=chunk-ZJIUWD7E.js.map