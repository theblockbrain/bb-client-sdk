import { describe, expect, it, vi } from "vitest";
import { createTranslator, resolveCatalogueName } from "./translator.js";

const AVAILABLE = ["en", "de", "vi", "zh_Hans"];

describe("resolveCatalogueName", () => {
  it("strips the region Office sends, which is the whole reason this exists", () => {
    // Office hands out RFC 1766 tags. A lookup on the raw value finds no
    // `en-US.json` and every user falls to the fallback.
    expect(resolveCatalogueName("en-US", AVAILABLE)).toBe("en");
    expect(resolveCatalogueName("de-AT", AVAILABLE)).toBe("de");
    expect(resolveCatalogueName("vi-VN", AVAILABLE)).toBe("vi");
  });

  it("reaches a script-named catalogue from a region-named tag", () => {
    // `zh-CN` and `zh_Hans` share no prefix, so nothing but the region-to-script
    // map connects them.
    expect(resolveCatalogueName("zh-CN", AVAILABLE)).toBe("zh_Hans");
    expect(resolveCatalogueName("zh-SG", AVAILABLE)).toBe("zh_Hans");
  });

  it("matches a script subtag directly, region and all", () => {
    expect(resolveCatalogueName("zh-Hans-CN", AVAILABLE)).toBe("zh_Hans");
  });

  it("serves Traditional Chinese from Simplified rather than English", () => {
    // No zh_Hant catalogue ships. The right language in the wrong script is
    // closer to readable than the fallback.
    expect(resolveCatalogueName("zh-TW", AVAILABLE)).toBe("zh_Hans");
  });

  it("prefers an exact script catalogue over the region map when both exist", () => {
    expect(resolveCatalogueName("zh-TW", ["en", "zh_Hans", "zh_Hant"])).toBe("zh_Hant");
  });

  it("is case and separator insensitive, since hosts disagree on both", () => {
    expect(resolveCatalogueName("DE-de", AVAILABLE)).toBe("de");
    expect(resolveCatalogueName("zh_hans", AVAILABLE)).toBe("zh_Hans");
  });

  it("falls back for a language nothing covers", () => {
    expect(resolveCatalogueName("ja-JP", AVAILABLE)).toBe("en");
  });

  it("falls back when the host reports no locale at all", () => {
    // Word on the web does not support displayLanguage, so undefined is a real
    // runtime case rather than a defensive one.
    expect(resolveCatalogueName(undefined, AVAILABLE)).toBe("en");
    expect(resolveCatalogueName("", AVAILABLE)).toBe("en");
    expect(resolveCatalogueName("   ", AVAILABLE)).toBe("en");
  });

  it("returns something usable when the fallback itself is missing", () => {
    expect(resolveCatalogueName("ja-JP", ["de", "vi"], "en")).toBe("de");
  });

  it("returns the fallback name when there are no catalogues", () => {
    expect(resolveCatalogueName("de-DE", [], "en")).toBe("en");
  });
});

describe("createTranslator", () => {
  const catalogues = {
    en: {
      greeting: "Hello",
      withName: "Hello {name}",
      "items.one": "{count} item",
      "items.other": "{count} items",
    },
    de: {
      greeting: "Hallo",
      withName: "Hallo {name}",
      "items.one": "{count} Element",
      "items.other": "{count} Elemente",
    },
    vi: { greeting: "Xin chao", withName: "Xin chao {name}", "items.other": "{count} muc" },
  };

  it("resolves the catalogue from the host tag", () => {
    expect(createTranslator({ locale: "de-DE", catalogues }).locale).toBe("de");
  });

  it("reports the raw tag alongside the catalogue chosen", () => {
    const t = createTranslator({ locale: "de-AT", catalogues });
    expect(t.requested).toBe("de-AT");
    expect(t.locale).toBe("de");
  });

  it("translates", () => {
    expect(createTranslator({ locale: "de-DE", catalogues }).t("greeting")).toBe("Hallo");
  });

  it("interpolates named placeholders", () => {
    expect(createTranslator({ locale: "en-US", catalogues }).t("withName", { name: "Ada" })).toBe(
      "Hello Ada",
    );
  });

  it("leaves an unsupplied placeholder visible rather than blanking it", () => {
    // A sentence missing its number still reads like a finished sentence, so
    // silently dropping it hides the bug.
    expect(createTranslator({ locale: "en-US", catalogues }).t("withName")).toBe("Hello {name}");
  });

  it("picks the plural category for the count", () => {
    const t = createTranslator({ locale: "en-US", catalogues });
    expect(t.t("items", { count: 1 })).toBe("1 item");
    expect(t.t("items", { count: 5 })).toBe("5 items");
  });

  it("uses the target language's own plural rules, not English ones", () => {
    // Vietnamese has only `other`. An English-shaped count check would look for
    // `items.one` at count 1 and find nothing.
    const t = createTranslator({ locale: "vi-VN", catalogues });
    expect(t.t("items", { count: 1 })).toBe("1 muc");
    expect(t.t("items", { count: 5 })).toBe("5 muc");
  });

  it("serves a key missing from the chosen catalogue out of the fallback", () => {
    // A catalogue added later starts incomplete. A half-translated pane beats
    // one with a raw key on a button.
    const t = createTranslator({
      locale: "vi-VN",
      catalogues: { ...catalogues, vi: { greeting: "Xin chao" } },
    });
    expect(t.t("withName", { name: "Ada" })).toBe("Hello Ada");
  });

  it("returns the key itself when nothing has it, and says so once", () => {
    const onMissing = vi.fn();
    const t = createTranslator({ locale: "en-US", catalogues, onMissing });
    expect(t.t("nope.not.here")).toBe("nope.not.here");
    expect(onMissing).toHaveBeenCalledWith("nope.not.here", "en");
  });

  it("answers has() without going through t()", () => {
    const t = createTranslator({ locale: "en-US", catalogues });
    expect(t.has("greeting")).toBe(true);
    expect(t.has("nope")).toBe(false);
  });

  it("does not fall over when the resolved catalogue is absent", () => {
    expect(createTranslator({ locale: "en-US", catalogues: {} }).t("greeting")).toBe("greeting");
  });
});
