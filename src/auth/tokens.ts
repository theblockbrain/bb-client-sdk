import {
  createFetchTransport,
  type Transporter,
  type TransportResponse,
} from "../api/transport.js";
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
  /** Optional transport (PDEV-7339). Defaults to `fetch` at the endpoint's origin. */
  transport?: Transporter,
): Promise<TokenResult> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  const res = await postToken(tokenEndpoint, params, transport);

  if (!res.ok) {
    const code = await oauthErrorCode(res);
    throw new Error(`Token exchange failed: ${describeTokenFailure(res.status, code)}`);
  }

  return res.json<TokenResult>();
}

/**
 * POST a form-encoded grant to the token endpoint, through the transport.
 *
 * Auth runs **before** an `AuthContext` exists — `exchangeCode` is what produces
 * one — so the transport cannot ride on `ctx` the way every `./api` call does.
 * It arrives as a parameter instead (PDEV-7339). Never a module singleton: that
 * is process-wide mutable state, and it is what disqualified the same shape for
 * the API transport.
 *
 * Why route auth through the seam at all, when a plain `fetch` POST works in
 * every runtime including React Native: `b2b-webcomponents` rewrites every
 * request to `${PROXY_URL}/wc/proxy${pathname}`. A token call on bare `fetch`
 * skips that rewrite — and skips the timeout, retry and custom headers every
 * other call gets. Auth is the last call that should be on its own code path.
 *
 * `tokenEndpoint` stays an absolute URL in the public signature so no caller has
 * to change; it is split into the `auth` host, a path and a query here.
 *
 * The query is carried in `TransportRequest.query`, not appended to `path` —
 * `path` is contractually "path only" and the transport has a field for this.
 * RFC 6749 §3.2 allows the token endpoint to carry a query component and
 * requires it to be **retained** when further parameters are added, so dropping
 * it would silently break any IdP or proxy that uses one.
 */
async function postToken(
  tokenEndpoint: string,
  params: URLSearchParams,
  transport: Transporter | undefined,
): Promise<TransportResponse> {
  const endpoint = new URL(tokenEndpoint);
  const send = transport ?? createFetchTransport({ hosts: { auth: endpoint.origin } });
  const query = Object.fromEntries(endpoint.searchParams);
  return send.send({
    host: "auth",
    path: endpoint.pathname,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
}

/** RFC 6749 §5.2 — the closed set of token-endpoint error codes. */
const OAUTH_ERROR_CODES: readonly string[] = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
];

/**
 * The RFC 6749 §5.2 `error` code off a failed token response, or `null`.
 *
 * An **allowlist, not a passthrough**. The raw body of a failed token call must
 * never reach a thrown message or a log line: `error_description` is free text
 * from the AS, a misconfigured proxy can echo the submitted grant (which carries
 * `code_verifier` / `refresh_token`), and a non-OAuth failure returns whatever
 * HTML the edge produced. Consumers routinely stringify a thrown error into
 * Sentry, so anything in the message is effectively published (invariant D).
 *
 * Matching against the spec's fixed vocabulary keeps the one genuinely useful
 * diagnostic — `invalid_grant` vs `invalid_client` — while making it impossible
 * for server-controlled text to ride along. Never throws: it is called while
 * building an error, and failing there would mask the real failure.
 */
async function oauthErrorCode(res: TransportResponse): Promise<string | null> {
  try {
    const body = await res.json<{ error?: unknown }>();
    const code = body?.error;
    return typeof code === "string" && OAUTH_ERROR_CODES.includes(code) ? code : null;
  } catch {
    return null;
  }
}

/** `"401 (invalid_grant)"` when the code is a known one, else `"401"`. */
function describeTokenFailure(status: number, code: string | null): string {
  return code ? `${status} (${code})` : String(status);
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
  /** Optional transport (PDEV-7339). Defaults to `fetch` at the endpoint's origin. */
  transport?: Transporter,
): Promise<TokenResult> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });

  const res = await postToken(tokenEndpoint, params, transport);

  if (!res.ok) {
    // Status + the allowlisted OAuth code only. This previously logged the raw
    // body immediately below a comment warning that the body can echo the grant.
    const code = await oauthErrorCode(res);
    const detail = describeTokenFailure(res.status, code);
    console.error("[auth] refreshTokens failed:", detail);
    throw new Error(`Token refresh failed: ${detail}`);
  }

  return res.json<TokenResult>();
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
