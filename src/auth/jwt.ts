/**
 * Client-side JWT utilities — no signature verification (server validates).
 * Avoids the `jose` dependency by implementing the minimal decode needed.
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
 * Decode a JWT payload without verifying the signature.
 * Returns null on malformed input so callers can handle gracefully.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    // base64url → base64 → binary string → UTF-8
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Try to extract an orgId from decoded JWT claims.
 *
 * Zitadel may place the org id in any of three locations depending on
 * which scopes were requested and how the project is configured:
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
      const firstOrgKey = Object.keys(firstRole as Record<string, unknown>)[0];
      if (firstOrgKey) return firstOrgKey;
    }
  }

  return null;
}

/**
 * Decode the ID token and extract the user profile.
 *
 * When `accessToken` is provided, it is used as a fallback source for orgId in case
 * Zitadel did not embed it in the id_token. Access tokens may be opaque (reference tokens)
 * depending on the Zitadel project config, so the fallback decode is wrapped in try/catch.
 */
export function extractProfile(idToken: string, accessToken?: string): Profile {
  const idClaims = decodeJwtPayload(idToken) ?? {};

  let orgId = extractOrgIdFromClaims(idClaims);

  if (!orgId && accessToken) {
    try {
      const accessClaims = decodeJwtPayload(accessToken);
      if (accessClaims) {
        orgId = extractOrgIdFromClaims(accessClaims);
      }
    } catch {
      // access_token may be opaque (reference token) — not a JWT, silently ignore
    }
  }

  return {
    sub: typeof idClaims.sub === "string" ? idClaims.sub : "",
    email: typeof idClaims.email === "string" ? idClaims.email : undefined,
    name: typeof idClaims.name === "string" ? idClaims.name : undefined,
    given_name: typeof idClaims.given_name === "string" ? idClaims.given_name : undefined,
    family_name:
      typeof idClaims.family_name === "string" ? idClaims.family_name : undefined,
    orgId,
  };
}
