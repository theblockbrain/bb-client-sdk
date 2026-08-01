/**
 * Client-side JWT claim reading — no signature verification (the server validates).
 *
 * One decoder, deliberately (PDEV-7684). There used to be two — `auth/jwt.ts`
 * and `utils/jwt.ts` — and exactly one real difference between them:
 *
 * - `auth/jwt.ts` decoded the raw bytes through `TextDecoder`, so non-ASCII
 *   claims survived intact.
 * - `utils/jwt.ts` ran `JSON.parse(atob(...))` directly. `atob` yields a *binary
 *   string*, one char per byte, so every multi-byte UTF-8 sequence came out
 *   mojibake: `"Müller"` decoded as `"MÃ¼ller"`.
 *
 * PDEV-7684 was written expecting the opposite conclusion — that the padded
 * (`utils`) implementation was the correct one to keep, because the other never
 * restored base64 padding. **That was wrong, and adopting it would have
 * regressed `extractProfile` for every non-ASCII name** — not theoretical for a
 * German-first customer base, since `name` is rendered in the UI.
 *
 * The padding difference turns out to be unreachable, not a bug: base64 of n
 * bytes is `4*ceil(n/3)` chars, so with padding stripped the length is ≡ 0, 2 or
 * 3 (mod 4) and never 1 — the one residue `atob` rejects. Padding is restored
 * below anyway, because it costs one line and makes the function correct for
 * hand-constructed input rather than merely correct in practice.
 *
 * Signature verification is intentionally omitted: the backend verifies on every
 * request. Reading claims client-side is safe only because nothing here makes a
 * trust decision — `sub` travels to the server as a hint it can cross-check.
 */

export interface Profile {
  sub: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  orgId: string | null;
}

/**
 * Decode a JWT payload segment. Returns `null` on anything unexpected — a
 * non-JWT (an `sk-` API key, an opaque reference token), malformed base64, or
 * invalid JSON. It must never throw: callers pass user-supplied tokens.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  // A JWT is header.payload.signature. An unsigned one still has three parts
  // with an empty third, so anything else is not a JWT.
  if (parts.length !== 3) return null;

  const segment = parts[1];
  if (!segment) return null;

  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    // Restore stripped padding: atob rejects a length that is not a multiple of 4.
    const padding = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
    const binary = atob(base64 + padding);
    // atob returns a binary string, one char per byte. Reading it directly would
    // corrupt every multi-byte UTF-8 sequence, so decode the bytes properly.
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Try to extract an orgId from decoded JWT claims.
 *
 * Zitadel may place the org id in any of three locations depending on which
 * scopes were requested and how the project is configured:
 *
 *   1. `urn:zitadel:iam:org:id`                — direct string (org-scoped login)
 *   2. `urn:zitadel:iam:user:resourceowner:id` — direct string ("User Info in ID Token" enabled)
 *   3. `urn:zitadel:iam:org:project:roles`     — object whose first role value has the
 *      orgId as its first key (project roles requested)
 *
 * Note: `blockbrain:grants[0]` looks like `<id>:<role>` but the leading id is a
 * Blockbrain project-id, NOT a Zitadel org-id — do not use it as a fallback here.
 *
 * Returns the first non-empty value found, or null.
 */
export function extractOrgIdFromClaims(claims: Record<string, unknown>): string | null {
  const direct = claims["urn:zitadel:iam:org:id"];
  if (typeof direct === "string" && direct.length > 0) return direct;

  const resourceOwner = claims["urn:zitadel:iam:user:resourceowner:id"];
  if (typeof resourceOwner === "string" && resourceOwner.length > 0) return resourceOwner;

  const roles = claims["urn:zitadel:iam:org:project:roles"];
  if (roles !== null && typeof roles === "object") {
    const firstRole = Object.values(roles as Record<string, unknown>)[0];
    if (firstRole !== null && typeof firstRole === "object") {
      const firstOrgKey = Object.keys(firstRole)[0];
      if (firstOrgKey) return firstOrgKey;
    }
  }

  return null;
}

/**
 * Decode the ID token and extract the user profile.
 *
 * When `accessToken` is provided it is a fallback source for orgId, in case
 * Zitadel did not embed it in the id_token. Access tokens may be opaque
 * (reference tokens) depending on project config, so a failed decode there is
 * expected and ignored.
 */
export function extractProfile(idToken: string, accessToken?: string): Profile {
  const idClaims = decodeJwtPayload(idToken) ?? {};

  let orgId = extractOrgIdFromClaims(idClaims);

  if (!orgId && accessToken) {
    const accessClaims = decodeJwtPayload(accessToken);
    if (accessClaims) orgId = extractOrgIdFromClaims(accessClaims);
  }

  return {
    sub: typeof idClaims.sub === "string" ? idClaims.sub : "",
    email: typeof idClaims.email === "string" ? idClaims.email : undefined,
    name: typeof idClaims.name === "string" ? idClaims.name : undefined,
    given_name: typeof idClaims.given_name === "string" ? idClaims.given_name : undefined,
    family_name: typeof idClaims.family_name === "string" ? idClaims.family_name : undefined,
    orgId,
  };
}

/**
 * Extract the `sub` claim from a Zitadel access token.
 *
 * Feeds `getAuthContext`'s userId auto-derivation, which the Agentic path needs
 * as `resourceId`. Returns `null` for a non-JWT (an `sk-` API key) rather than
 * throwing, so callers need not gate on `mode === "oauth"` first.
 */
export function subFromAccessToken(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const sub = payload?.sub;
  return typeof sub === "string" && sub.length > 0 ? sub : null;
}
