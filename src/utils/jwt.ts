/**
 * Minimal JWT payload reader — no signature verification.
 *
 * We only need to read the `sub` claim from Zitadel access tokens so the SDK
 * can auto-fill `resourceId` for Agentic calls without requiring callers to
 * thread a userId through their auth wiring.
 *
 * Signature verification is intentionally OMITTED here: the backend verifies
 * the token on every request. Reading the sub client-side is safe because we
 * never make trust decisions based on it — it is sent to the server as a
 * `resourceId` hint that the server can cross-check against the verified JWT.
 */

/** Typed JWT payload — only the fields we use; rest are allowed via index sig. */
interface JwtPayload {
  sub?: string;
  [key: string]: unknown;
}

/**
 * Decode a JWT payload segment (base64url) and parse it as JSON.
 * Returns `null` on any error: non-JWT input, malformed base64, invalid JSON.
 */
function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const b64 = parts[1];
  if (!b64) return null;

  try {
    // base64url → base64 (pad to multiple of 4)
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const decoded = atob(padded + padding);
    return JSON.parse(decoded) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Extract the `sub` claim from a Zitadel access-token JWT.
 *
 * Returns the sub string when the token is a valid JWT with a non-empty sub
 * claim. Returns `null` for:
 * - Non-JWT tokens (API keys, opaque tokens)
 * - JWTs without a `sub` claim
 * - Malformed input
 *
 * Returns `null` for non-JWT tokens such as `sk-` API keys, so callers need
 * not gate on `mode === "oauth"` — the shape-check handles it gracefully.
 */
export function subFromAccessToken(token: string): string | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const sub = payload.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}
