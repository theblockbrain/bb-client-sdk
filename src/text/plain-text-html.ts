/**
 * Plain model output → HTML fragment, for insertion into an Office document body.
 *
 * Not a markdown renderer, and not a substitute for one. `./ui`'s
 * `markdownToHtml` parses markdown; this handles the *opposite* contract — a
 * prompt that instructed the model to emit *no* markdown, which is what the
 * email and document surfaces do because Outlook and Word bodies are not
 * markdown targets. The model still emits list-shaped prose (`- item`,
 * `1. item`) out of habit, and inserting that verbatim shows literal `- `
 * characters in the sent mail. So: real `<ul>`/`<ol>`, everything else escaped
 * and joined with `<br>`.
 *
 * Shared because both Office surfaces reached the same place independently —
 * `ms-outlook-addin`'s `plainTextToHtml` and `ms-word-addin`'s
 * `chatContentToHtml` / `ensureHtmlBlocks`.
 *
 * **Escaping is not sanitising.** Every text node is escaped here, so no markup
 * in the model's output can become live HTML. That is a correctness guarantee
 * about *this* function's output, not a licence to skip a sanitiser: the caller
 * hands the result to a host API that renders it, and defence in depth is the
 * rule for anything model-authored. Outlook runs the result through DOMPurify
 * before `body.setAsync`, and should keep doing so.
 */

/** Bullet-list line: "• item", "- item" or "* item". */
const BULLET_LINE = /^\s*[•\-*]\s+(.*)$/;
/** Numbered-list line: "1. item" or "1) item". */
const NUMBERED_LINE = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Escape the five characters that can start markup or break out of an attribute.
 *
 * `&` must be replaced first or it would double-escape the entities the later
 * replacements introduce. Quotes are covered too: the output is documented as an
 * HTML *fragment*, and a caller that interpolates a fragment into an attribute
 * should not be the one to discover they were not.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Convert plain text to an HTML fragment suitable for an Office body.
 *
 * Consecutive bullet lines become one `<ul>`, consecutive numbered lines one
 * `<ol>`, and a run of either ends when the other or ordinary prose begins.
 * Everything else is escaped and joined with `<br>`. CRLF and CR are normalised
 * first, because Office bodies and IMAP-sourced text both supply them.
 */
export function plainTextToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let textRun: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let items: string[] = [];

  const flushText = (): void => {
    if (textRun.length) {
      blocks.push(textRun.join("<br>"));
      textRun = [];
    }
  };
  const flushList = (): void => {
    if (listType) {
      blocks.push(`<${listType}>${items.map(item => `<li>${item}</li>`).join("")}</${listType}>`);
      listType = null;
      items = [];
    }
  };

  for (const raw of lines) {
    const bullet = raw.match(BULLET_LINE);
    const numbered = bullet ? null : raw.match(NUMBERED_LINE);
    if (bullet) {
      flushText();
      if (listType !== "ul") flushList();
      listType = "ul";
      items.push(escapeHtml(bullet[1].trim()));
    } else if (numbered) {
      flushText();
      if (listType !== "ol") flushList();
      listType = "ol";
      items.push(escapeHtml(numbered[1].trim()));
    } else {
      flushList();
      textRun.push(escapeHtml(raw));
    }
  }
  flushText();
  flushList();

  return blocks.join("");
}

/**
 * The tags {@link plainTextToHtml} can emit.
 *
 * Exported so a caller's sanitiser allow-list cannot drift from what this
 * function actually produces — Outlook's DOMPurify config previously listed
 * these by hand, and a new tag here would have been silently stripped.
 */
export const PLAIN_TEXT_HTML_TAGS: readonly string[] = ["br", "ul", "ol", "li"];
