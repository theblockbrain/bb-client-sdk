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

export const AUTH_AUTHORITY = "https://auth.theblockbrain.ai";

/**
 * Backend URL for OAuth mode — hardcoded to production because OAuth tokens
 * are issued by auth.theblockbrain.ai and are only valid against this audience.
 * bbUrl (user-configurable) must not override this; it is only respected in API-Key mode.
 */
export const OAUTH_BACKEND_URL = "https://blocky.theblockbrain.ai";

export const AUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "blockbrain:grants",
] as const;

export const TOKEN_ENDPOINT = `${AUTH_AUTHORITY}/oauth/v2/token`;
export const AUTHORIZE_ENDPOINT = `${AUTH_AUTHORITY}/oauth/v2/authorize`;
