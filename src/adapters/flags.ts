/**
 * Feature-flag port (L10).
 *
 * Surfaces gate behaviour on flags today by reading their own config, so the same
 * capability is enabled in three different ways and the SDK cannot gate anything
 * of its own. This is the seam: the SDK asks, the host answers.
 *
 * **Synchronous and total.** A flag read happens on a render path, so it cannot
 * await, and it must not throw — a flag provider being slow, misconfigured or
 * absent has to degrade to the caller's fallback rather than break the feature it
 * was meant to gate. That is the opposite of a config read, which is allowed to
 * fail loudly.
 */

/** What a host implements. Both methods must be synchronous and must not throw. */
export interface FlagAdapter {
  /**
   * Whether `flag` is on. Return `fallback` when the flag is unknown — do not
   * invent a default, because the caller's fallback encodes whether the feature
   * is opt-in or opt-out.
   */
  isEnabled(flag: string, fallback: boolean): boolean;
  /**
   * Optional string-valued variant, for a multi-arm experiment. Return `null`
   * when unknown.
   */
  getVariant?(flag: string): string | null;
}

let registered: FlagAdapter | null = null;

/** Register the host's flag provider. Pass `null` to return to defaults-only. */
export function setFlagAdapter(adapter: FlagAdapter | null): void {
  registered = adapter;
}

/** Test seam: drop any registered adapter. */
export function resetFlagAdapter(): void {
  registered = null;
}

/** The registered adapter, or `null` when the host has not wired one. */
export function getFlagAdapter(): FlagAdapter | null {
  return registered;
}

/**
 * Read a flag.
 *
 * `fallback` defaults to `false`, so an un-wired host gets every gated feature
 * off — a new capability staying dark is recoverable, one switching on
 * unexpectedly is not.
 *
 * A throwing adapter is swallowed and the fallback returned. The alternative is a
 * host's flag bug taking down an unrelated feature, which is the failure mode this
 * port exists to prevent.
 */
export function isFeatureEnabled(flag: string, fallback = false): boolean {
  if (!registered) return fallback;
  try {
    return registered.isEnabled(flag, fallback);
  } catch {
    return fallback;
  }
}

/** Variant for a multi-arm flag, or `null` when unknown or unsupported. */
export function getFeatureVariant(flag: string): string | null {
  if (!registered?.getVariant) return null;
  try {
    return registered.getVariant(flag);
  } catch {
    return null;
  }
}
