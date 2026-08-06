import { describe, expect, it } from "vitest";
import { PLAIN_TEXT_HTML_TAGS, plainTextToHtml } from "./plain-text-html.js";

/**
 * The cases that matter are the ones the two Office add-ins got wrong
 * independently: a list that never became a list (literal `- ` in a sent mail),
 * and model output escaping into live markup.
 */
describe("plainTextToHtml", () => {
  it("returns an empty fragment for empty input", () => {
    expect(plainTextToHtml("")).toBe("");
  });

  it("joins prose lines with <br>", () => {
    expect(plainTextToHtml("one\ntwo")).toBe("one<br>two");
  });

  it("normalises CRLF and bare CR", () => {
    // Office bodies and IMAP-sourced text both supply these; splitting on "\n"
    // alone leaves a trailing \r inside the escaped text node.
    expect(plainTextToHtml("one\r\ntwo\rthree")).toBe("one<br>two<br>three");
  });

  it.each([
    ["dash", "- a\n- b"],
    ["asterisk", "* a\n* b"],
    ["bullet char", "• a\n• b"],
  ])("turns consecutive %s lines into one <ul>", (_label, input) => {
    expect(plainTextToHtml(input)).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it.each([
    ["dotted", "1. a\n2. b"],
    ["parenthesised", "1) a\n2) b"],
  ])("turns consecutive %s numbered lines into one <ol>", (_label, input) => {
    expect(plainTextToHtml(input)).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("closes one list and opens another when the marker changes", () => {
    expect(plainTextToHtml("- a\n1. b")).toBe("<ul><li>a</li></ul><ol><li>b</li></ol>");
  });

  it("keeps prose, list and prose in source order", () => {
    // The flush ordering is the whole risk here: a mis-ordered flush silently
    // moves the list above the paragraph that introduced it.
    expect(plainTextToHtml("intro\n- a\noutro")).toBe("intro<ul><li>a</li></ul>outro");
  });

  it("escapes markup in prose", () => {
    expect(plainTextToHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes markup inside list items", () => {
    expect(plainTextToHtml("- <b>x</b>")).toBe("<ul><li>&lt;b&gt;x&lt;/b&gt;</li></ul>");
  });

  it("escapes & first so entities are not double-escaped", () => {
    // "&lt;" must survive as a literal, not become "&amp;lt;".
    expect(plainTextToHtml("a & b <c>")).toBe("a &amp; b &lt;c&gt;");
  });

  it("escapes both quote characters", () => {
    // The output is documented as a fragment; a caller interpolating it into an
    // attribute should not be the one to discover quotes were left raw.
    expect(plainTextToHtml(`"x" 'y'`)).toBe("&quot;x&quot; &#39;y&#39;");
  });

  it("does not treat a marker without a following space as a list", () => {
    expect(plainTextToHtml("-notalist")).toBe("-notalist");
  });

  it("emits no tag outside the declared allow-list", () => {
    const html = plainTextToHtml("intro\nsecond line\n- a\n1. b\nend & <x>");
    const tags = [...html.matchAll(/<\/?([a-z]+)>/g)].map(match => match[1]);

    // The point of exporting the list: a consumer's sanitiser config is derived
    // from it, so a new tag here must not be able to appear without updating it.
    expect(new Set(tags)).toEqual(new Set(["ul", "li", "ol", "br"]));
    for (const tag of tags) expect(PLAIN_TEXT_HTML_TAGS).toContain(tag);
  });
});
