/**
 * Default OAuth configuration for BlockBrain Zitadel apps.
 * AUTH_CLIENT_ID is shared across all BB frontends (Chrome, Outlook, future).
 */
declare const AUTH_AUTHORITY = "https://auth.theblockbrain.ai";
/**
 * Backend URL for OAuth mode — hardcoded to production because OAuth tokens
 * are issued by auth.theblockbrain.ai and are only valid against this audience.
 * bbUrl (user-configurable) must not override this; it is only respected in API-Key mode.
 */
declare const OAUTH_BACKEND_URL = "https://blocky.theblockbrain.ai";
declare const AUTH_CLIENT_ID = "373051238587049311";
declare const AUTH_SCOPES: readonly ["openid", "profile", "email", "offline_access", "blockbrain:grants"];
declare const TOKEN_ENDPOINT = "https://auth.theblockbrain.ai/oauth/v2/token";
declare const AUTHORIZE_ENDPOINT = "https://auth.theblockbrain.ai/oauth/v2/authorize";

export { AUTHORIZE_ENDPOINT, AUTH_AUTHORITY, AUTH_CLIENT_ID, AUTH_SCOPES, OAUTH_BACKEND_URL, TOKEN_ENDPOINT };
