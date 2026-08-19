/**
 * End a session at the identity provider, not just in local storage.
 *
 * Until this existed the SDK had no revocation and no RP-initiated logout at all:
 * `grep -rn "revoke|end_session|logout" src/` matched only a telemetry event NAME.
 * Signing out discarded the stored tokens locally while the refresh token issued
 * under `offline_access` stayed valid at Zitadel for its full lifetime. On a shared
 * or stolen device that is the difference between a sign-out and the appearance of
 * one.
 *
 * ─── Why this cannot reject ────────────────────────────────────────────────────
 *
 * A revocation is a best-effort network call made at the exact moment the user has
 * asked to leave. Refusing to sign someone out because the IdP is unreachable is
 * strictly worse than the token outliving the session, so failure is reported in
 * the return value rather than thrown. The caller should clear local state either
 * way, and can decide whether an un-revoked token is worth surfacing.
 *
 * RFC 7009 section 2.2 already requires the server to answer 200 for a token it does
 * not recognise, so a non-200 here means the request did not land, not that the
 * token was bad.
 */

import { createFetchTransport, type Transporter } from "../api/transport.js";
import { REVOKE_ENDPOINT } from "../config.js";

export interface LogoutOptions {
  /** The OAuth client the tokens were issued to. */
  clientId: string;
  /**
   * The refresh token. Preferred over the access token, because revoking it drops
   * the whole grant rather than one short-lived credential.
   */
  refreshToken?: string;
  /** Used only when there is no refresh token to revoke. */
  accessToken?: string;
  /** Override for a self-hosted or non-production Zitadel. */
  revokeEndpoint?: string;
  transport?: Transporter;
  signal?: AbortSignal;
}

export interface LogoutResult {
  /**
   * Whether the IdP confirmed the revocation.
   *
   * `false` means the local session is gone but the token may still be live at the
   * IdP until it expires. Worth logging; not worth blocking the user on.
   */
  revoked: boolean;
}

/**
 * Revoke the session's tokens at the IdP.
 *
 * Always resolves. Clear local auth state regardless of the result.
 */
export async function logout(options: LogoutOptions): Promise<LogoutResult> {
  const { clientId, refreshToken, accessToken, transport, signal } = options;

  // A refresh token revocation invalidates the grant, so it is the one that
  // actually ends the session. The access token is the fallback for a surface that
  // was never granted `offline_access`.
  const token = refreshToken?.trim() || accessToken?.trim();
  if (!token) return { revoked: false };
  const hint = refreshToken?.trim() ? "refresh_token" : "access_token";

  const params = new URLSearchParams({
    token,
    token_type_hint: hint,
    client_id: clientId,
  });

  try {
    // Inside the guard, not above it. `new URL()` throws on a malformed override, and
    // this function's whole contract is that it never rejects — a caller typo in
    // `revokeEndpoint` must not be the reason a sign-out fails to clear local state.
    const endpoint = new URL(options.revokeEndpoint ?? REVOKE_ENDPOINT);
    const send = transport ?? createFetchTransport({ hosts: { auth: endpoint.origin } });

    const res = await send.send({
      host: "auth",
      path: endpoint.pathname,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal,
    });
    return { revoked: res.ok };
  } catch {
    // Deliberately swallowed. The token is the one thing that must not reach a log
    // line here, and the caller has no action to take beyond clearing local state,
    // which it is about to do anyway.
    return { revoked: false };
  }
}
