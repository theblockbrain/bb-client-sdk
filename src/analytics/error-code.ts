/**
 * Derive the taxonomy's coarse `error_code` from a thrown value.
 *
 * Shared rather than reimplemented per call site, for the reason `scrub.ts` is
 * shared: two copies of a classifier drift, and the one that drifts is the one
 * feeding the dashboard nobody is watching yet.
 *
 * ─── Why it reads the error STRUCTURALLY ───────────────────────────────────────
 *
 * It never imports `BBApiError`. Both call sites are in different layers
 * (`./api`, `./auth`) and a telemetry helper must not be the thing that drags the
 * transport graph into a surface that only wanted the sink — the same constraint
 * that keeps `./analytics` React-free and DOM-free (invariants A + B). Duck-typing
 * two known-safe numeric/string fields costs nothing and couples to nothing.
 *
 * ─── What it deliberately does NOT read ────────────────────────────────────────
 *
 * Never `message`, never `stack`, never `responseBody`. Those are free text, they
 * can echo a submitted token, and the taxonomy forbids all three
 * (`DENIED_PROPERTY_KEYS` + `SECRET_DENYLIST` would strip them at the sink
 * anyway). A code is groupable; a message is one Mixpanel bucket per string.
 */

/**
 * `kind` first, then `statusCode` — the ordering `src/api/errors.ts` prescribes:
 * "`statusCode` alone cannot tell a network drop from a timeout — both report 0".
 * So an `aborted`/`network`/`timeout`/`parse` failure codes as that word, and only
 * a real HTTP response codes as its number.
 *
 * @returns a low-cardinality label (`"401"`, `"503"`, `"timeout"`, `"aborted"`),
 * or `undefined` when the value carries neither field — better an absent property
 * than a fabricated one.
 */
export function telemetryErrorCode(error: unknown): string | undefined {
  const shape = error as { kind?: unknown; statusCode?: unknown } | null | undefined;
  const kind = typeof shape?.kind === "string" ? shape.kind : undefined;
  const statusCode = typeof shape?.statusCode === "number" ? shape.statusCode : undefined;

  // Every kind except `http` already IS the distinction worth reporting, and its
  // `statusCode` is 0 — which would collapse them all into one useless bucket.
  if (kind !== undefined && kind !== "http") return kind;
  if (statusCode !== undefined) return String(statusCode);
  return kind;
}
