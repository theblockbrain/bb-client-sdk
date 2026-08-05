import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIntlFormatter,
  formatDate,
  formatNumber,
  formatRelativeTime,
  resetFormatterAdapter,
  setFormatterAdapter,
} from "./formatter.js";
import { BB_MESSAGE_KEYS } from "./keys.js";

afterEach(() => {
  resetFormatterAdapter();
  vi.restoreAllMocks();
});

/**
 * L12 · the formatter port.
 *
 * `timeAgo` is deliberately NOT routed through this: it emits `"5m ago"` and
 * `Intl.RelativeTimeFormat` emits `"5 minutes ago"`, so swapping one for the other
 * would change every rendered timestamp in every surface. Surfaces opt in via
 * `formatRelativeTime`.
 */
describe("FormatterAdapter", () => {
  it("prefers a registered formatter over the Intl default", () => {
    setFormatterAdapter({
      date: () => "HOST-DATE",
      number: () => "HOST-NUM",
      relativeTime: () => "HOST-REL",
    });

    expect(formatDate(0)).toBe("HOST-DATE");
    expect(formatNumber(1)).toBe("HOST-NUM");
    expect(formatRelativeTime(0)).toBe("HOST-REL");
  });

  it("formats a relative past instant in words, not the compact timeAgo form", () => {
    // Locale is pinned: the assertion is about *wording*, and the module default takes the
    // machine's locale — on a de_DE box this renders "vor 5 Minuten" and /minute/ fails.
    const formatter = createIntlFormatter("en-US");
    expect(formatter.relativeTime(Date.now() - 5 * 60_000)).toMatch(/minute/);
  });

  it("handles a future instant, which timeAgo could not express at all", () => {
    const formatter = createIntlFormatter("en-US");
    expect(formatter.relativeTime(Date.now() + 3 * 3_600_000)).toMatch(/hour/);
  });

  it("routes formatRelativeTime through Intl, whatever the machine's locale", () => {
    // Locale-independent: asserts only that the module-level function does NOT emit the
    // compact fallback, which is the one thing that must remain true in every locale.
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).not.toBe("5m ago");
  });

  it("swallows a throwing host formatter and degrades to the Intl default", () => {
    // `FormatterAdapter` says methods must not throw, but a host with a misconfigured
    // locale library is exactly the case this port exists for. A formatter must never be
    // the reason a screen fails to render — the same rule the flag port applies.
    const explode = () => {
      throw new Error("host locale lib exploded");
    };
    setFormatterAdapter({ date: explode, number: explode, relativeTime: explode });

    expect(() => formatDate(0)).not.toThrow();
    expect(() => formatNumber(1)).not.toThrow();
    expect(() => formatRelativeTime(0)).not.toThrow();
    // Not just "did not throw" — it produced the platform default's answer.
    expect(formatDate(0)).toBe(createIntlFormatter().date(0));
    expect(formatNumber(1234.5)).toBe(createIntlFormatter().number(1234.5));
  });

  it("falls back to a locale-independent string when Intl is absent", () => {
    // Hermes without hermes-intl. A formatter must never be why a screen fails.
    const formatter = createIntlFormatter();
    vi.spyOn(globalThis, "Intl", "get").mockReturnValue(undefined as unknown as typeof Intl);

    expect(formatter.relativeTime(Date.now() - 90 * 60_000)).toBe("1h ago");
    expect(formatter.number(42)).toBe("42");
    expect(formatter.date(0)).toBe(new Date(0).toISOString());
  });

  it("falls back rather than throwing on a bad locale", () => {
    const formatter = createIntlFormatter("not-a-locale!!");
    expect(() => formatter.date(0)).not.toThrow();
    expect(() => formatter.number(1)).not.toThrow();
    expect(() => formatter.relativeTime(0)).not.toThrow();
  });

  it("says 'just now' for an instant inside the minute", () => {
    const formatter = createIntlFormatter();
    vi.spyOn(globalThis, "Intl", "get").mockReturnValue(undefined as unknown as typeof Intl);
    expect(formatter.relativeTime(Date.now() - 1_000)).toBe("just now");
  });
});

describe("BBMessageKey vocabulary", () => {
  it("lists every key exactly once", () => {
    expect(new Set(BB_MESSAGE_KEYS).size).toBe(BB_MESSAGE_KEYS.length);
  });
});
