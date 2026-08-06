import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./markdown.js";

/**
 * The escaping contract of `markdown.ts`.
 *
 * This module had **no** tests, while depending on marked's *exact* per-token
 * HTML-escaping behaviour — which fields arrive escaped (`text`, `codespan.text`,
 * `escape.text`) and which arrive verbatim (fenced code, the token-less list
 * fallback). Six comments in `markdown.ts` document those assumptions; nothing
 * enforced them, so a marked major bump could change rendered output on every
 * React surface and the suite would stay green.
 *
 * It already had: upgrading marked 14 -> 18 fixed a double-escape in autolink
 * text and image alt (`&amp;amp;` -> `&amp;`), meaning users previously saw a
 * literal "&amp;". That was found by diffing rendered output across the bump, not
 * by any test. These cases pin the corrected behaviour.
 *
 * Assertions are exact strings on purpose. A "contains" check would not catch a
 * double-escape, which is the failure mode that actually shipped.
 */
describe("markdownToHtml — escaping contract", () => {
  it("escapes ampersands and angles in plain text exactly once", () => {
    expect(markdownToHtml("a & b")).toBe("<p>a &amp; b</p>");
  });

  it("escapes a codespan's contents", () => {
    expect(markdownToHtml("`a & b`")).toBe("<p><code>a &amp; b</code></p>");
    expect(markdownToHtml("`<script>alert(1)</script>`")).toBe(
      "<p><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></p>",
    );
  });

  it("renders a backslash escape as the literal character, escaped once", () => {
    expect(markdownToHtml("\\& \\< \\> \\_")).toBe("<p>&amp; &lt; &gt; _</p>");
  });

  it("keeps fenced code verbatim, escaping only for HTML safety", () => {
    expect(markdownToHtml("```\nconst a = b & c; // <tag> 'q'\n```")).toBe(
      "<pre><code>const a = b &amp; c; // &lt;tag&gt; 'q'</code></pre>",
    );
  });

  it("escapes list item text once", () => {
    expect(markdownToHtml("- one & two\n- three < four")).toBe(
      "<ul><li>one &amp; two</li><li>three &lt; four</li></ul>",
    );
  });

  it("does not double-escape autolink text (regressed until marked 18)", () => {
    // marked 14 emitted `...&amp;amp;b=2` here, so the rendered link text showed a
    // literal "&amp;" to the user.
    expect(markdownToHtml("https://example.test/x?a=1&b=2")).toBe(
      '<p><a href="https://example.test/x?a=1&amp;b=2" target="_blank" rel="noreferrer noopener">https://example.test/x?a=1&amp;b=2</a></p>',
    );
  });

  it("does not double-escape image alt text (regressed until marked 18)", () => {
    expect(markdownToHtml("![alt & text](https://example.test/i.png)")).toBe(
      "<p>alt &amp; text</p>",
    );
  });

  it("leaves an already-escaped entity in the source alone", () => {
    // Input "&amp;" is literal text meaning "&amp;", so it escapes to "&amp;amp;".
    // Distinguishing this from the autolink bug above is the whole point.
    expect(markdownToHtml("&amp; &lt; &#39; &quot;")).toBe(
      "<p>&amp;amp; &amp;lt; &amp;#39; &amp;quot;</p>",
    );
  });
});

describe("markdownToHtml — link safety", () => {
  it("keeps an allowed protocol and hardens the anchor", () => {
    expect(markdownToHtml("[text](https://example.test/a?b=1&c=2)")).toBe(
      '<p><a href="https://example.test/a?b=1&amp;c=2" target="_blank" rel="noreferrer noopener">text</a></p>',
    );
  });

  it("drops the anchor for a javascript: URL, keeping the text", () => {
    // The protocol allowlist is a security boundary, not a style choice.
    expect(markdownToHtml("[x](javascript:alert(1))")).toBe("<p>x</p>");
  });

  it("never emits raw HTML from the source", () => {
    expect(markdownToHtml("<div onclick='x'>hi</div>")).toBe(
      "&lt;div onclick='x'&gt;hi&lt;/div&gt;",
    );
  });
});
