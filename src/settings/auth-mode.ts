import { subFromAccessToken } from "../auth/jwt-claims.js";
import { isTokenExpired } from "../auth/tokens.js";
import type { BBHosts } from "../config.js";
import { OAUTH_BACKEND_URL } from "../config.js";
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
  /**
   * Zitadel user ID (`sub` claim from the ID token).
   * Present in OAuth mode only — undefined in api-key mode.
   *
   * Required for Agentic API calls (`resourceId` in the request body).
   * Agentic is OAuth-only; callers should throw when this is absent and they
   * need the Agentic path.
   */
  userId?: string;
  /**
   * Per-host origin overrides. Optional — each host falls back to its entry in
   * {@link DEFAULT_HOSTS}.
   *
   * BlockBrain is three hosts, not one (PDEV-7332): `blocky` serves conversations
   * and messages, `integrations` serves agents / capabilities / tenants behind a
   * different auth pipeline, and `agentic` serves agent execution. `baseUrl` above
   * can only express one of them, which is why `useAgents`, `useCapabilities` and
   * `useTenantConfig` were unusable through a single provider.
   *
   * Supply this to point at a non-production environment — blocky-mobile runs
   * `integrations.dev.` and `integrations.qa.` variants:
   *
   * ```ts
   * const ctx = { ...base, hosts: { integrations: "https://integrations.qa.theblockbrain.ai" } };
   * ```
   *
   * Origins only. Path prefixes such as {@link INTEGRATIONS_API_PREFIX} are the
   * SDK's and survive an override.
   *
   * `baseUrl` is deliberately left in place rather than replaced: removing it would
   * move all 28 API signatures and break PDEV-7337's no-signature-change rule.
   * PDEV-7337 feeds this same record into the transport's host resolution.
   */
  hosts?: Partial<BBHosts>;
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
 * @param config.userId Zitadel user ID (`Profile.sub`) — populate from `extractProfile(idToken).sub`
 *   after a successful OAuth login. When omitted in OAuth mode, the SDK derives it automatically
 *   from the `sub` claim of the access-token JWT — so callers that don't thread userId explicitly
 *   still get Agentic routing. Intentionally absent in api-key mode (Agentic is OAuth-only).
 */
export function getAuthContext(
  settings: Settings,
  tokens: OAuthTokens | null,
  config: { oauthBaseUrl?: string; userId?: string } = {},
): AuthContext | null {
  if (tokens?.accessToken && settings.bbOrgId && !isTokenExpired(tokens.expirationMs)) {
    // Prefer the caller-supplied userId; fall back to the `sub` claim in the
    // access-token JWT so consumers that don't thread userId explicitly still
    // get a populated userId for Agentic calls. Only attempted in OAuth mode
    // (api-key tokens are not JWTs and do not carry a sub claim).
    const userId = config.userId ?? subFromAccessToken(tokens.accessToken) ?? undefined;
    return {
      baseUrl: config.oauthBaseUrl ?? OAUTH_BACKEND_URL,
      token: tokens.accessToken,
      orgId: settings.bbOrgId,
      mode: "oauth",
      userId,
    };
  }

  if (settings.bbToken) {
    return {
      baseUrl: settings.bbUrl,
      token: settings.bbToken,
      orgId: settings.bbOrgId || "",
      mode: "api-key",
      // userId is intentionally absent in api-key mode — Agentic is OAuth-only
    };
  }

  return null;
}

/** True when the user has at least one viable auth method available. */
export function hasUsableAuth(settings: Settings, tokens: OAuthTokens | null): boolean {
  return getAuthContext(settings, tokens) !== null;
}
