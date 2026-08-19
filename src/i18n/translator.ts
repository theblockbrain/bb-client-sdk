/**
 * Message lookup for host applications that ship their own string catalogues.
 *
 * The SDK owns the mechanism, the app owns the strings, the same split
 * {@link BBMessageKey} already draws. An add-in hands over its catalogues and a
 * host locale tag and gets back a `t`; nothing here knows what any key means.
 *
 * Separate from {@link FormatterAdapter}, which is a process-wide singleton
 * because a number formats the same way wherever it is called. A catalogue is
 * not like that: two panes in one host can want different ones, and tests need
 * to build a translator without disturbing anything else. So this returns an
 * instance and registers nothing.
 */

export type Catalogue = Readonly<Record<string, string>>;

export interface Translator {
  /** The catalogue actually in use, which is not always the one asked for. */
  readonly locale: string;
  /** The host tag this was resolved from, kept for diagnostics. */
  readonly requested: string;
  t(key: string, vars?: Readonly<Record<string, string | number>>): string;
  has(key: string): boolean;
}

export interface TranslatorOptions {
  /**
   * A host locale tag such as `en-US`. Office hands these out region-qualified
   * while catalogues are usually named bare, which is what
   * {@link resolveCatalogueName} exists to bridge.
   */
  locale?: string;
  /** Keyed by catalogue name, e.g. `{ en, de, vi, zh_Hans }`. */
  catalogues: Readonly<Record<string, Catalogue>>;
  /** Used when the tag matches nothing. Must be present in `catalogues`. */
  fallback?: string;
  /** Called once per missing key. For a dev warning, not for control flow. */
  onMissing?: (key: string, locale: string) => void;
}

const canonical = (tag: string): string => tag.trim().toLowerCase().replace(/_/g, "-");

/**
 * Chinese is the case a plain prefix match gets wrong.
 *
 * `zh-CN` and `zh_Hans` are the same language and share no prefix, so a catalogue
 * named for the script is unreachable from a tag named for the region. Mapping
 * region to script first is what connects them. Everything else falls out of the
 * ordinary language-then-region rules.
 */
const SCRIPT_BY_REGION: Readonly<Record<string, string>> = {
  "zh-cn": "zh-hans",
  "zh-sg": "zh-hans",
  "zh-my": "zh-hans",
  "zh-tw": "zh-hant",
  "zh-hk": "zh-hant",
  "zh-mo": "zh-hant",
};

/**
 * Pick the catalogue that best serves a host locale tag.
 *
 * Most specific first: the whole tag, then language plus script, then the bare
 * language, then the fallback. A tag we have no catalogue for returns the
 * fallback rather than throwing, because a missing translation must never be
 * the reason a pane fails to render.
 */
export function resolveCatalogueName(
  tag: string | undefined,
  available: readonly string[],
  fallback = "en",
): string {
  if (!available.length) return fallback;

  const byCanonical = new Map(available.map(name => [canonical(name), name]));
  const pick = (candidate: string): string | undefined => byCanonical.get(candidate);

  if (tag?.trim()) {
    const wanted = canonical(tag);
    const parts = wanted.split("-");
    const language = parts[0] ?? "";

    const candidates = [
      wanted,
      SCRIPT_BY_REGION[wanted],
      // `zh-hans-cn` to `zh-hans`: keep a script subtag, drop the region.
      parts.length > 2 && parts[1]?.length === 4 ? `${language}-${parts[1]}` : undefined,
      language,
    ];

    for (const candidate of candidates) {
      const hit = candidate ? pick(candidate) : undefined;
      if (hit) return hit;
    }

    // A regional tag whose script we hold under a different region, e.g. `zh-hk`
    // when only `zh_Hans` ships. Better the right language than the fallback.
    const sameLanguage = available.find(name => canonical(name).split("-")[0] === language);
    if (sameLanguage) return sameLanguage;
  }

  return pick(canonical(fallback)) ?? available[0];
}

/**
 * Plural category for a count.
 *
 * `Intl.PluralRules` rather than a count check, because the categories differ
 * per language: Vietnamese and Chinese have only `other`, so an English-shaped
 * `n === 1` test produces a key those catalogues do not carry. Falls back to the
 * English rule where `Intl.PluralRules` is missing, which is old React Native
 * without the Intl build.
 */
function pluralCategory(locale: string, count: number): string {
  try {
    return new Intl.PluralRules(locale).select(count);
  } catch {
    return count === 1 ? "one" : "other";
  }
}

const interpolate = (template: string, vars?: Readonly<Record<string, string | number>>): string =>
  vars
    ? template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        // An absent value leaves its token visible. Rendering nothing would hide
        // the bug in something that still reads like a finished sentence.
        name in vars ? String(vars[name]) : whole,
      )
    : template;

export function createTranslator(options: TranslatorOptions): Translator {
  const { catalogues, locale: requested, fallback = "en", onMissing } = options;
  const names = Object.keys(catalogues);
  const locale = resolveCatalogueName(requested, names, fallback);

  const primary = catalogues[locale] ?? {};
  const backstop = catalogues[fallback] ?? {};

  /**
   * A key absent from the chosen catalogue is served from the fallback rather
   * than rendered as the key. The parity test in each app is what keeps the four
   * catalogues aligned, but a catalogue added later starts incomplete, and a
   * half-translated pane beats one with `auth.login.submit` on a button.
   */
  const lookup = (key: string): string | undefined => primary[key] ?? backstop[key];

  return {
    locale,
    requested: requested ?? "",
    has: key => lookup(key) !== undefined,
    t(key, vars) {
      const count = vars?.count;
      const template =
        typeof count === "number"
          ? (lookup(`${key}.${pluralCategory(locale, count)}`) ??
            lookup(`${key}.other`) ??
            lookup(key))
          : lookup(key);

      if (template === undefined) {
        onMissing?.(key, locale);
        return key;
      }
      return interpolate(template, vars);
    },
  };
}
