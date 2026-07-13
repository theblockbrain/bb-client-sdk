import { TOKEN_ENDPOINT } from "../config.js";

export interface TokenResult {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  expires_in: number;
}

/**
 * Exchange an authorization code for tokens (PKCE authorization_code grant).
 *
 * @param code        Authorization code from the redirect callback.
 * @param verifier    PKCE code verifier generated before the authorize redirect.
 * @param redirectUri Must match the URI registered in Zitadel and used in the authorize URL.
 * @param clientId    OAuth client_id — must be provided by the caller.
 * @param tokenEndpoint Defaults to TOKEN_ENDPOINT.
 */
export async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  clientId: string,
  tokenEndpoint = TOKEN_ENDPOINT,
): Promise<TokenResult> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.status.toString());
    throw new Error(`Token exchange failed: ${text}`);
  }

  return (await res.json()) as TokenResult;
}

/**
 * Refresh the access token using the refresh_token grant.
 *
 * `scope` is intentionally omitted from the request body. RFC 6749 §6 makes it
 * optional; when absent, the AS re-grants all original scopes. Sending it
 * triggers Zitadel `invalid_scope` because custom scopes like `blockbrain:grants`
 * are not accepted in refresh requests — only in the initial authorization.
 *
 * @param refreshToken  Stored refresh token.
 * @param clientId      OAuth client_id — must be provided by the caller.
 * @param tokenEndpoint Defaults to TOKEN_ENDPOINT.
 */
export async function refreshTokens(
  refreshToken: string,
  clientId: string,
  tokenEndpoint = TOKEN_ENDPOINT,
): Promise<TokenResult> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[auth] refreshTokens failed:", res.status, text);
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  return (await res.json()) as TokenResult;
}

/** Compute the expiration timestamp (ms) from an expires_in value (seconds). */
export function computeExpiration(expiresInSeconds: number): number {
  return Date.now() + expiresInSeconds * 1000;
}

/** True when the token expires within the given lead time (default: 60 seconds). */
export function isTokenExpired(expirationMs: number | null, leadMs = 60_000): boolean {
  if (!expirationMs) return true;
  return expirationMs - Date.now() < leadMs;
}
