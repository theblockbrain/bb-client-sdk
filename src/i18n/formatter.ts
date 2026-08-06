/**
 * Formatter port (L12).
 *
 * Dates, numbers and relative times are locale-dependent, and the SDK must not
 * decide a surface's locale. The port lets a host supply its own formatting —
 * Office add-ins get the locale from `Office.context.displayLanguage`, SPFx from
 * the page context, mobile from the device — while the default uses `Intl`.
 *
 * `Intl` is dereferenced lazily inside the default, never at import time, so this
 * module stays importable where `Intl` is absent or partial (invariant B). Hermes
 * without `hermes-intl` is the real case.
 */

/** What a host implements. All methods must be synchronous and must not throw. */
export interface FormatterAdapter {
  /** Absolute date/time. */
  date(value: Date | number, options?: Readonly<Record<string, unknown>>): string;
  /** A number, currency or percentage. */
  number(value: number, options?: Readonly<Record<string, unknown>>): string;
  /** Relative time — "5 minutes ago". Receives a past or future instant. */
  relativeTime(value: Date | number): string;
}

let registered: FormatterAdapter | null = null;

/**
 * Register the host's formatter. Pass `null` to fall back to the `Intl` default.
 *
 * The adapter is **wrapped, not stored raw**. `FormatterAdapter` documents that its methods
 * must not throw, but a host cannot be trusted to honour it — a misconfigured locale library
 * is exactly the case this port exists for — and a formatter must never be the reason a
 * screen fails to render. Each method falls back to the `Intl` default, which is itself
 * total. Same rule the flag port applies to a throwing provider.
 *
 * Wrapped once here rather than on every read, so `formatDate` and friends stay allocation-free.
 */
export function setFormatterAdapter(adapter: FormatterAdapter | null): void {
  registered = adapter === null ? null : guarded(adapter);
}

/** Run `attempt`; on any throw, fall back to the platform default. */
function attempt<T>(run: () => T, fallback: () => T): T {
  try {
    return run();
  } catch {
    return fallback();
  }
}

function guarded(host: FormatterAdapter): FormatterAdapter {
  return {
    date: (value, options) =>
      attempt(
        () => host.date(value, options),
        () => platformDefault.date(value, options),
      ),
    number: (value, options) =>
      attempt(
        () => host.number(value, options),
        () => platformDefault.number(value, options),
      ),
    relativeTime: value =>
      attempt(
        () => host.relativeTime(value),
        () => platformDefault.relativeTime(value),
      ),
  };
}

/** Test seam: drop any registered adapter. */
export function resetFormatterAdapter(): void {
  registered = null;
}

const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

/**
 * A {@link FormatterAdapter} over `Intl`.
 *
 * `numeric: "auto"` is chosen so recent instants read "yesterday" rather than
 * "1 day ago", which is what a user expects and what `timeAgo` could never do.
 *
 * Every method falls back to a locale-independent rendering if `Intl` is missing
 * or throws on the locale: a formatter must never be the reason a screen fails to
 * render.
 */
export function createIntlFormatter(locale?: string): FormatterAdapter {
  const intl = (): typeof Intl | undefined => (globalThis as { Intl?: typeof Intl }).Intl;

  return {
    date: (value, options) => {
      const d = value instanceof Date ? value : new Date(value);
      try {
        const I = intl();
        if (!I) return d.toISOString();
        return new I.DateTimeFormat(locale, options).format(d);
      } catch {
        return d.toISOString();
      }
    },
    number: (value, options) => {
      try {
        const I = intl();
        if (!I) return String(value);
        return new I.NumberFormat(locale, options).format(value);
      } catch {
        return String(value);
      }
    },
    relativeTime: value => {
      const ts = value instanceof Date ? value.getTime() : value;
      const deltaMs = ts - Date.now();
      try {
        const I = intl();
        if (!I?.RelativeTimeFormat) return fallbackRelative(deltaMs);
        const rtf = new I.RelativeTimeFormat(locale, { numeric: "auto" });
        const abs = Math.abs(deltaMs);
        if (abs < MS.hour) return rtf.format(Math.round(deltaMs / MS.minute), "minute");
        if (abs < MS.day) return rtf.format(Math.round(deltaMs / MS.hour), "hour");
        return rtf.format(Math.round(deltaMs / MS.day), "day");
      } catch {
        return fallbackRelative(deltaMs);
      }
    },
  };
}

/** Locale-independent last resort, matching `timeAgo`'s shape. */
function fallbackRelative(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const suffix = deltaMs < 0 ? " ago" : " from now";
  if (abs < MS.minute) return "just now";
  if (abs < MS.hour) return `${Math.floor(abs / MS.minute)}m${suffix}`;
  if (abs < MS.day) return `${Math.floor(abs / MS.hour)}h${suffix}`;
  return `${Math.floor(abs / MS.day)}d${suffix}`;
}

const platformDefault = createIntlFormatter();

/** The registered formatter, else the `Intl` default. */
export function getFormatter(): FormatterAdapter {
  return registered ?? platformDefault;
}

/** Format an absolute date through the active formatter. */
export function formatDate(
  value: Date | number,
  options?: Readonly<Record<string, unknown>>,
): string {
  return getFormatter().date(value, options);
}

/** Format a number through the active formatter. */
export function formatNumber(value: number, options?: Readonly<Record<string, unknown>>): string {
  return getFormatter().number(value, options);
}

/**
 * Format a relative time through the active formatter.
 *
 * The localised replacement for `timeAgo`, which is kept as-is: it emits
 * `"5m ago"` and this emits `"5 minutes ago"`, so switching one for the other
 * would change every rendered timestamp. Surfaces opt in.
 */
export function formatRelativeTime(value: Date | number): string {
  return getFormatter().relativeTime(value);
}
