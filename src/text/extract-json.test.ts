import { describe, expect, it } from "vitest";
import { closeUnbalancedJson, extractJson, repairUnescapedQuotes } from "./extract-json.js";

/**
 * This module shipped with no tests at all, which is how it kept a one-token
 * lookahead that the Word add-in had already measured as insufficient.
 *
 * The cases below are the ones the add-in paid for in production. Every "German"
 * fixture is real in shape: the model writes German quotation marks as an
 * opening `„` (U+201E) plus a CLOSING ASCII `"`, so the stray quote always
 * lands in the middle of a sentence and is always followed by a structural
 * character.
 */
describe("extractJson", () => {
  it("parses a clean JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips a markdown code fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("extracts the JSON block out of surrounding prose", () => {
    expect(extractJson('Sure! Here you go: {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it("returns null for total garbage instead of throwing", () => {
    expect(extractJson("not json at all")).toBeNull();
    expect(extractJson("")).toBeNull();
  });

  it.each([
    ["unclosed brace with nothing to anchor on", "{"],
    ["prose with a lone bracket", "see footnote [1] for details"],
    ["a fence with no JSON in it", "```\njust text\n```"],
    ["structure-only noise", '{[}]:,"'],
    ["a half-written key", '{"edi'],
  ])("does not throw on %s", (_label, input) => {
    expect(() => extractJson(input)).not.toThrow();
  });

  // PDEV-7477. The single-quote form recovered before this change too (the
  // character after the stray quote is `)`, which the old one-token rule already
  // rejected). It is kept as the incident's own regression guard.
  it("recovers the German closing-quote case", () => {
    const raw = '{"modified":"Wir haben die „3 fehlenden Commits").\\n"}';

    expect(extractJson(raw)).toEqual({
      modified: 'Wir haben die „3 fehlenden Commits").\n',
    });
  });

  // The case one-token lookahead got wrong: the comma sits directly after a
  // quote that belongs to the prose, so the old rule closed the string there and
  // lost parity for the whole rest of the document.
  it("keeps a value whose stray quote is followed by a comma", () => {
    const raw = '{"modified":"Setze „node", was die Map ignoriert.","position":"replace"}';

    expect(extractJson(raw)).toEqual({
      modified: 'Setze „node", was die Map ignoriert.',
      position: "replace",
    });
  });

  // Matching keywords by first letter would read `nein` as the start of `null`
  // and accept the comma as structure.
  it("does not read German prose after a stray quote as a null literal", () => {
    const raw = '{"modified":"Setze „node", nein doch nicht.","position":"replace"}';

    expect(extractJson(raw)).toEqual({
      modified: 'Setze „node", nein doch nicht.',
      position: "replace",
    });
  });

  it("recovers the complete elements of a truncated envelope", () => {
    // Output token ceiling hit mid-element: the third edit stops in the middle
    // of a value. The two that fully arrived are still usable.
    const raw =
      '{"edits":[{"original":"A","modified":"B"},{"original":"C","modified":"D"},{"original":"E","modified":"Attachment par';

    expect(extractJson(raw)).toEqual({
      edits: [
        { original: "A", modified: "B" },
        { original: "C", modified: "D" },
      ],
    });
  });

  it("recovers the complete elements of a truncated bare array", () => {
    // The first-block regex cannot express this one: with no `]` anywhere it
    // falls through to the first `{` and yields `{…},{…}`, which no bracket
    // repair can fix. The structural slice anchors on the `[` instead.
    const raw = '[{"original":"A","modified":"B"},{"original":"C","modified":"D"},{"original":"E"';

    expect(extractJson(raw)).toEqual([
      { original: "A", modified: "B" },
      { original: "C", modified: "D" },
    ]);
  });

  it("recovers when the trailing partial element mentions a bracket", () => {
    // Measured in the add-in: the last `}` in the text belongs to `Vorlage {x}`
    // INSIDE a string, so slicing at "the last bracket character" lands
    // mid-string and the whole response is discarded. Anchoring on the last
    // structural closer keeps the one complete edit.
    const raw =
      '{"edits":[{"original":"A","modified":"B"},{"original":"Vorlage {x}","modified":"Templ';

    expect(extractJson(raw)).toEqual({ edits: [{ original: "A", modified: "B" }] });
  });

  it("returns null when the response is cut off inside a string", () => {
    // Nothing here is recoverable: the fragment ends inside an unterminated
    // string and there is no complete element before it. Closing the quote would
    // fabricate a value, so null is the honest answer.
    const raw = '{"edits":[{"original":"Vorlage {x}","modified":"Templ';

    expect(extractJson(raw)).toBeNull();
  });

  it("recovers a response that needs quote repair AND closing", () => {
    // Both defects at once. Closing alone fails, because the stray quote makes
    // the fragment look like it ends inside a string. Quote repair alone fails,
    // because the brackets are still open.
    const raw =
      '{"edits":[{"original":"A","modified":"Setze „node", was ignoriert wird."},{"original":"C","modified":"cut';

    expect(extractJson(raw)).toEqual({
      edits: [{ original: "A", modified: 'Setze „node", was ignoriert wird.' }],
    });
  });

  it("never rewrites a response that already parses", () => {
    // The repair passes only run after a plain parse has failed, so a value
    // containing a legitimately escaped quote survives untouched.
    const raw = '{"text":"He said \\"hi\\", then left"}';

    expect(extractJson(raw)).toEqual({ text: 'He said "hi", then left' });
  });
});

describe("repairUnescapedQuotes", () => {
  it("leaves already-escaped quotes alone", () => {
    // Regression guard: double-escaping turns `\"` into `\\"`, which parses as a
    // literal backslash followed by the end of the string.
    const raw = '{"text":"He said \\"hi\\" loudly"}';

    expect(repairUnescapedQuotes(raw)).toBe(raw);
  });

  it.each([
    ["a key terminator before a colon", '{"a":1}'],
    ["a value terminator before a comma", '{"a":"b","c":1}'],
    ["a terminator before a closing brace", '{"a":"b"}'],
    ["a terminator before a closing bracket", '{"a":["b"]}'],
    ["a terminator at end of input", '"b'],
    ["whitespace between the tokens", '{ "a" : "b" , "c" : 1 }'],
    ["a nested closer run", '[{"a":["b"]}]'],
  ])("leaves valid JSON untouched: %s", (_label, raw) => {
    expect(repairUnescapedQuotes(raw)).toBe(raw);
  });

  it.each([
    ["true", '["x",true]'],
    ["false", '["x",false]'],
    ["null", '["x",null]'],
    ["a negative number", '["x",-1]'],
    ["a digit", '["x",7]'],
  ])("accepts a real terminator followed by %s", (_label, raw) => {
    expect(repairUnescapedQuotes(raw)).toBe(raw);
  });

  it("escapes a stray quote followed by a comma and prose", () => {
    expect(repairUnescapedQuotes('{"a":"Setze „node", was folgt."}')).toBe(
      '{"a":"Setze „node\\", was folgt."}',
    );
  });

  it("escapes a stray quote before a word that merely starts like a keyword", () => {
    // `nein` / `treu` / `falsch` all begin with a JSON keyword's first letter.
    for (const word of ["nein", "treu", "falsch"]) {
      expect(repairUnescapedQuotes(`{"a":"Setze „node", ${word} doch."}`)).toBe(
        `{"a":"Setze „node\\", ${word} doch."}`,
      );
    }
  });

  it("escapes a stray quote followed by prose with no structural character", () => {
    expect(repairUnescapedQuotes('{"a":"die „3 Commits").\\n"}')).toBe(
      '{"a":"die „3 Commits\\").\\n"}',
    );
  });

  it("treats the character after a closer as the second token", () => {
    // `"}` is only a terminator when what follows the `}` can follow a value.
    // Here `x` cannot, so the quote is content.
    expect(repairUnescapedQuotes('{"a":"end „q"} x"}')).toBe('{"a":"end „q\\"} x"}');
  });

  it("passes a trailing backslash through without consuming past the end", () => {
    expect(repairUnescapedQuotes('{"a":"b\\')).toBe('{"a":"b\\');
  });
});

describe("closeUnbalancedJson", () => {
  it("returns null when the brackets are already balanced", () => {
    expect(closeUnbalancedJson('{"a":1}')).toBeNull();
    expect(closeUnbalancedJson("[1,2]")).toBeNull();
  });

  it("returns null when the fragment ends inside a string", () => {
    // The missing tail is content, not structure. Guessing corrupts.
    expect(closeUnbalancedJson('{"a":"unfinished')).toBeNull();
  });

  it("appends the outstanding closers in reverse order", () => {
    expect(closeUnbalancedJson('{"edits":[{"a":1}')).toBe('{"edits":[{"a":1}]}');
    expect(closeUnbalancedJson('[{"a":1},{"b":2}')).toBe('[{"a":1},{"b":2}]');
  });

  it("ignores brackets that sit inside string values", () => {
    expect(closeUnbalancedJson('{"a":"Fussnote [1] und {x}"')).toBe('{"a":"Fussnote [1] und {x}"}');
  });

  it("ignores an escaped quote when tracking string context", () => {
    // Without escape handling this reads as "string closed then reopened", and
    // the parity error either invents closers or refuses a valid fragment.
    expect(closeUnbalancedJson('{"a":"He said \\"hi\\""')).toBe('{"a":"He said \\"hi\\""}');
  });
});
