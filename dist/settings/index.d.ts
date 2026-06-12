interface Settings {
    bbUrl: string;
    bbToken: string;
    bbOrgId: string;
    bbBotId: string;
    bbBotName: string;
    useSystemPrompt: boolean;
    authMode: AuthMode;
}
declare const DEFAULTS: Settings;

type AuthMode = "oauth" | "api-key";
interface AuthContext {
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
}
interface OAuthTokens {
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
declare function inferAuthMode(loaded: Partial<Settings>): AuthMode;
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
 *   after a successful OAuth login. Required for Agentic API calls; callers without it
 *   will receive `userId: undefined` and the Agentic path will throw a hard error.
 *   Intentionally absent in api-key mode (Agentic is OAuth-only).
 */
declare function getAuthContext(settings: Settings, tokens: OAuthTokens | null, config?: {
    oauthBaseUrl?: string;
    userId?: string;
}): AuthContext | null;
/** True when the user has at least one viable auth method available. */
declare function hasUsableAuth(settings: Settings, tokens: OAuthTokens | null): boolean;

export { type AuthContext, type AuthMode, DEFAULTS, type OAuthTokens, type Settings, getAuthContext, hasUsableAuth, inferAuthMode };
