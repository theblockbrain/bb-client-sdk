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

/**
 * Base URL for the Agentic API.
 *
 * The streaming endpoint is derived from this by replacing the trailing `/api`
 * segment with `/v2/api`, then appending `/agents/{agentId}/stream`:
 *
 *   https://agentic.theblockbrain.ai/api
 *   → https://agentic.theblockbrain.ai/v2/api/agents/{agentId}/stream
 */
export const AGENTIC_BASE_URL = "https://agentic.theblockbrain.ai/api";

/**
 * Base URL for the integrations host — the `agents`, `capabilities` and `tenants`
 * routes (see `src/api/_auth-headers.ts`, which documents the different auth
 * pipeline these use).
 *
 * Until now no integrations constant existed anywhere in the SDK, which is half of
 * the wrong-host bug in PDEV-7332: `agents.ts`, `capabilities.ts` and
 * `tenant-config.ts` all build their URLs from `ctx.baseUrl`, and that resolves to
 * {@link OAUTH_BACKEND_URL}.
 *
 * ⚠️ PATH PREFIX UNVERIFIED. The value below is the host only. Those three modules
 * currently build bare paths (`/agents`, `/capabilities`, `/tenants`), while
 * blocky-mobile's env config points at `https://integrations.theblockbrain.ai/api/v1`
 * for its own integrations calls. Whether our routes are mounted at the root or
 * under `/api/v1` has NOT been confirmed against Botticelli's `packages/integrations`.
 * **PDEV-7332 must confirm it before pointing any function here** — that ticket owns
 * the retargeting; this constant only gives it somewhere to point.
 *
 * Non-prod hosts follow the same pattern (`integrations.dev.` / `integrations.qa.`)
 * and are supplied per-surface via the transport's `hosts` override, not hardcoded.
 */
export const INTEGRATIONS_BASE_URL = "https://integrations.theblockbrain.ai";
