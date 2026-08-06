---
applyTo: "**/*.test.ts,**/*.test.tsx,scripts/**"
---

# Tests and gates

A test here exists to make a **decision falsifiable**, not to raise a coverage number. The
bar: if the behaviour regressed, would this test fail?

## Write the test that would have caught it

- **Assert the property, not the implementation.** `web-storage.test.ts` asserts the *stored
  bytes* are unencoded, because a JSON layer would silently break a pre-paint theme script
  reading the same key. That is the real contract.
- **Pin behaviour you depend on in a dependency.** `markdown.test.ts` pins `marked`'s escaping
  contract — `t.raw` over the HTML-escaped `t.text`, verbatim fenced code — because a major
  bump is free to change it and the module's correctness rests on it. A dep bump with no such
  test is unfalsifiable.
- **For anything security-adjacent, enumerate hazard classes first**, then write one case per
  class. Control characters, quote/delimiter breakout, unbounded length, surrogate splitting,
  BiDi overrides, empty and all-unsafe input. Testing only the hazard you first thought of is
  how a sanitizer ships with a hole.
- **Verify a new gate actually fails.** Introduce the defect it targets, watch it fail, then
  revert. A gate never observed failing is a gate you do not have. Make sure the failure comes
  from the gate and not from an earlier step in the pipeline.
- **Prefer a fixture over a mock** for wire formats — recorded SSE frames, real response
  shapes.

## Environment

`vitest`, jsdom where a DOM is needed. Target is **ES2022** — `String.prototype.toWellFormed`
and other ES2023+ library APIs are not available; write the check explicitly instead.

Tests must not depend on network, wall-clock time, or ambient DOM types the source does not
already require.

## `scripts/**`

These are release gates, not helpers. They run in CI and in `publish.yml` **before**
`npm publish`. Derive values from `package.json` rather than hardcoding them (see how
`peerSpecs` and the entry-point list are built) — a gate that floats to whatever npm ships
today breaks on the calendar rather than on a real defect. Print which item failed, not just
that the gate failed.
