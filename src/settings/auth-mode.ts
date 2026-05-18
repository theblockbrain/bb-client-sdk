import { OAUTH_BACKEND_URL } from "../config.js";
import { isTokenExpired } from "../auth/tokens.js";
import type { Settings } from "./schema.js";

export type AuthMode = "oauth" | "api-key";

export interface AuthContext {
  baseUrl: string;
  /** Bearer token — either OAuth access_token or API key */
  token: string;
  /**
   * User's HOME org ID — sent as x-zitadel-org-id header on all OAuth calls.
   * This is the org the JWT was issued for (where the user has roles).
   *
   * For cross-tenant admin operations, pass a separate `targetOrgId` to the
   * individual API functions — that becomes the ?orgId= query param (the tenant
   * being operated on). Do NOT put the target tenant's orgId here.
   */
  orgId: string;
  mode: AuthMode;
}

export interface OAuthTokens {
  accessToken: string;
  /** Unix timestamp (ms) when access_token expires. */
  expirationMs: number;
}

/**
 * Infer the correct authMode for a settings object.
 *
 * Rules (in order):
 * 1. If the stored value is an explicit, valid mode → honour it.
 * 2. If no stored value BUT a non-empty API token exists → "api-key"
 *    (preserves existing users from an unexpected tab switch).
 * 3. Otherwise → "oauth" (new-user default).
 */
export function inferAuthMode(loaded: Partial<Settings>): AuthMode {
  if (loaded.authMode === "api-key" || loaded.authMode === "oauth") {
    return loaded.authMode;
  }
  if (loaded.bbToken && loaded.bbToken.length > 0) {
    return "api-key";
  }
  return "oauth";
}

/**
 * Compute the active auth context from settings + OAuth token state.
 *
 * OAuth is preferred when tokens are present, orgId is known, and the token is not expired.
 * Falls back to API-Key mode when a bbToken exists.
 * Returns null when neither method is available.
 *
 * For OAuth mode: baseUrl is hardcoded to OAUTH_BACKEND_URL — OAuth tokens are issued by
 * auth.theblockbrain.ai and are only valid against this audience. settings.bbUrl is
 * intentionally ignored in OAuth mode.
 *
 * @param config.oauthBaseUrl Override for OAUTH_BACKEND_URL (e.g. in tests).
 */
export function getAuthContext(
  settings: Settings,
  tokens: OAuthTokens | null,
  config: { oauthBaseUrl?: string } = {},
): AuthContext | null {
  if (tokens?.accessToken && settings.bbOrgId && !isTokenExpired(tokens.expirationMs)) {
    return {
      baseUrl: config.oauthBaseUrl ?? OAUTH_BACKEND_URL,
      token: tokens.accessToken,
      orgId: settings.bbOrgId,
      mode: "oauth",
    };
  }

  if (settings.bbToken) {
    return {
      baseUrl: settings.bbUrl,
      token: settings.bbToken,
      orgId: settings.bbOrgId || "",
      mode: "api-key",
    };
  }

  return null;
}

/** True when the user has at least one viable auth method available. */
export function hasUsableAuth(settings: Settings, tokens: OAuthTokens | null): boolean {
  return getAuthContext(settings, tokens) !== null;
}
