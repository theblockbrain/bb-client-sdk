import { ACTION_SYSTEM_PROMPT } from "../actions/prompts.js";

export interface PageContext {
  title: string;
  url: string;
  meta?: string;
  html?: string;
  text?: string;
}

export type CspMode = "js-ok" | "actions-only";

/**
 * Build the LLM prompt for page-manipulation requests.
 * CSP-aware: actions-only mode omits JS instructions and embeds the Action Library spec.
 */
export function buildPagePrompt(
  userText: string,
  page: PageContext,
  cspMode: CspMode,
): string {
  const pageContext = `CURRENT PAGE:
- Title: ${page.title}
- URL: ${page.url}

PAGE HTML (cleaned):
${page.html ?? page.text ?? ""}

USER REQUEST:
${userText}`;

  if (cspMode === "actions-only") {
    return `You are a web page assistant. This page has a strict Content Security Policy that blocks JavaScript eval. You cannot provide JavaScript code — use the Action Library instead.

${pageContext}

INSTRUCTIONS:
For **action requests** ("Make headings red", "Hide the sidebar", "Click the login button"):
${ACTION_SYSTEM_PROMPT}

For **questions** ("What is this page about?", "Summarize this"):
Respond with plain markdown text. No JSON block needed.

The page HTML above is your source of truth.`;
  }

  return `You are a web page assistant. You can answer questions about the page or perform actions on it.

${pageContext}

INSTRUCTIONS:
Decide based on intent:

**Q&A / Explanation** ("What is this page about?", "Summarize this", "Find emails"):
- Respond with plain markdown. No code fence.

**Actions** ("Make headings red", "Hide the sidebar", "Click the login button"):
- Brief explanation (1-2 sentences), then JavaScript in a \`\`\`javascript code fence.
- Full DOM access. Top-level await supported. \`waitFor(selector, timeout?)\` available.

**Combined** ("Summarize and hide images"):
- Markdown answer first, then \`\`\`javascript code fence.

The page HTML is your source of truth. Never invent content not on the page.`;
}
