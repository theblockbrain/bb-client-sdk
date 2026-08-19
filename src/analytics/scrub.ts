/**
 * The property scrub both analytics leaves apply before anything leaves the process.
 *
 * Shared rather than duplicated per leaf, for the same reason the event taxonomy
 * is: two copies of a safety list drift, and the copy that drifts is the one that
 * leaks. The Mixpanel leaf owned this logic privately; Faro needs exactly the same
 * guarantees, so it lives here and both import it.
 *
 * ─── Two lists, because they answer different questions ────────────────────────
 *
 * {@link stripDeniedProperties} (from `./telemetry`) is the taxonomy's governance
 * list: **PII** — names, emails, message text, filenames — plus Mixpanel's
 * reserved `$`/`mp_` prefixes. It is deliberately not a secrets list.
 *
 * {@link SECRET_DENYLIST} below covers **credentials**: tokens, keys, cookies, the
 * PKCE verifier. A leaked display name is a privacy incident; a leaked refresh
 * token is an account takeover, and neither list catches the other's cases.
 *
 * This is a SECOND line of defence. The first is the typed taxonomy, which is a
 * closed set of primitive-valued, PII-free props. Matching here is name-based, so
 * a caller determined to send `userMail` will still succeed — callers must not
 * pass PII or secrets.
 */

import { stripDeniedProperties } from "../telemetry/taxonomy.js";

/**
 * Credential-bearing property names, already normalized (lowercased, separators
 * stripped) and matched EXACTLY against a normalized key.
 *
 * Exact rather than substring matching is deliberate: `status_code` normalizes to
 * `statuscode` and `error_name` to `errorname`, both of which a substring rule
 * against `code`/`name` would silently drop — taking the `api_error` and
 * `sdk_error` payloads with them.
 */
const SECRET_DENYLIST = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearer",
  "authorization",
  "password",
  "secret",
  "clientsecret",
  "apikey",
  "cookie",
  "sessionid",
  "code",
  "codeverifier",
  "verifier",
  "state",
  "responsebody",
  "stack",
]);

/** Lowercase and strip separators so `Access_Token`, `access-token` and `accessToken` all match. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

/**
 * Keep only JSON-safe primitives whose key is neither PII nor credential-shaped.
 *
 * An allowlist (`string | number | boolean`) rather than a "not an object" test,
 * for two reasons:
 *
 * 1. **Nothing object-shaped can leak.** The taxonomy is primitives-only by design,
 *    so a nested value is always a caller error — and dropping it means a
 *    `BBApiError`, a response body, or any object graph carrying a token can never
 *    be forwarded, whatever key it arrived under.
 * 2. **One bad field must not cost the whole event.** `bigint` and `symbol` are
 *    primitives but not JSON-safe: `JSON.stringify` THROWS on a bigint and silently
 *    omits a symbol. A sink serializes the payload, so a single stray bigint from
 *    an untyped caller would throw inside the vendor SDK, get swallowed by the
 *    adapter's catch, and take the entire event with it. Dropping the one field is
 *    strictly better than losing the event.
 *
 * `null`/`undefined` and functions fall out of the same check for free.
 */
export function scrubProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stripDeniedProperties(props))) {
    const type = typeof value;
    if (type !== "string" && type !== "number" && type !== "boolean") continue;
    if (SECRET_DENYLIST.has(normalizeKey(key))) continue;
    out[key] = value;
  }
  return out;
}
