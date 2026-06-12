/**
 * Shared OAuth configuration for BlockBrain Zitadel apps.
 *
 * AUTH_CLIENT_ID has been removed — each caller must inject its own client ID.
 * All LoginOptions / BrowserRedirectOptions interfaces require clientId explicitly.
 * Known IDs:
 *   Chrome addon / ms-outlook-addin : 373051238587049311
 *   bb-batch-analyzer (web)         : 373515197228255226
 *   bb-dashboard                    : (caller-specific, see that repo)
 */
declare const AUTH_AUTHORITY = "https://auth.theblockbrain.ai";
/**
 * Backend URL for OAuth mode — hardcoded to production because OAuth tokens
 * are issued by auth.theblockbrain.ai and are only valid against this audience.
 * bbUrl (user-configurable) must not override this; it is only respected in API-Key mode.
 */
declare const OAUTH_BACKEND_URL = "https://blocky.theblockbrain.ai";
declare const AUTH_SCOPES: readonly ["openid", "profile", "email", "offline_access", "blockbrain:grants"];
declare const TOKEN_ENDPOINT = "https://auth.theblockbrain.ai/oauth/v2/token";
declare const AUTHORIZE_ENDPOINT = "https://auth.theblockbrain.ai/oauth/v2/authorize";
/**
 * Base URL for the Agentic API.
 *
 * The streaming endpoint is derived from this by replacing the trailing `/api`
 * segment with `/v2/api`, then appending `/agents/{agentId}/stream`:
 *
 *   https://agentic.theblockbrain.ai/api
 *   → https://agentic.theblockbrain.ai/v2/api/agents/{agentId}/stream
 */
declare const AGENTIC_BASE_URL = "https://agentic.theblockbrain.ai/api";

export { AGENTIC_BASE_URL, AUTHORIZE_ENDPOINT, AUTH_AUTHORITY, AUTH_SCOPES, OAUTH_BACKEND_URL, TOKEN_ENDPOINT };
