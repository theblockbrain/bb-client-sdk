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
 * RFC 7009 token revocation.
 *
 * Added with `logout()`, which is the first thing in the SDK to end a session at the
 * IdP rather than only in local storage. Without it a sign-out left the
 * `offline_access` refresh token valid for its full lifetime, so a user signing out
 * on a shared or stolen device had ended nothing.
 */
export const REVOKE_ENDPOINT = `${AUTH_AUTHORITY}/oauth/v2/revoke`;

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
 * Origin of the integrations host — the `agents`, `capabilities` and `tenants`
 * routes (see `src/api/_auth-headers.ts`, which documents the different auth
 * pipeline these use).
 *
 * No integrations constant existed anywhere in the SDK before PDEV-7336, which is
 * half of the wrong-host bug in PDEV-7332: `agents.ts`, `capabilities.ts` and
 * `tenant-config.ts` all built their URLs from `ctx.baseUrl`, which resolves to
 * {@link OAUTH_BACKEND_URL}.
 *
 * Origin only — the path prefix is {@link INTEGRATIONS_API_PREFIX}. Non-prod hosts
 * follow the same pattern (`integrations.dev.` / `integrations.qa.`) and are supplied
 * per-surface via `AuthContext.hosts`, never hardcoded here.
 */
export const INTEGRATIONS_BASE_URL = "https://integrations.theblockbrain.ai";

/**
 * Path prefix every integrations route sits behind.
 *
 * VERIFIED against Botticelli 2026-07-29 (PDEV-7332), which is what unblocked the
 * retargeting: `packages/integrations/src/index.ts:227` mounts
 * `app.route('/api/v1/', v1Router)`, and `v1Router` in turn mounts `/agents`
 * (`agentStatusRoutesV1`), `/capabilities` (`capabilityStatusRoutesV1`) and
 * `/tenants` (`tenantsRoutesV1` + `tenantConfigRoutesV1`).
 *
 * This matches what blocky-mobile has always used —
 * `EXPO_PUBLIC_INTEGRATIONS_V2_API_URL = https://integrations.theblockbrain.ai/api/v1`
 * — so the SDK was wrong on two counts at once: the host AND the missing prefix.
 *
 * Kept separate from {@link INTEGRATIONS_BASE_URL} because a `hosts` override
 * supplies an ORIGIN; the prefix is ours and must survive the override.
 */
export const INTEGRATIONS_API_PREFIX = "/api/v1";

/**
 * The three BlockBrain hosts.
 *
 * Proxy mode is a URL rewrite, not a fourth host — b2b rewrites an already-built
 * URL rather than selecting a different origin (PDEV-7335).
 *
 * Lives here rather than beside the transport so that `./settings` can type
 * `AuthContext.hosts` without importing from `./api` — `src/api` already depends on
 * `src/settings`, and `src/config` is the leaf both can reach.
 */
export type BBHost = "blocky" | "integrations" | "agentic" | "auth";

export type BBHosts = Readonly<Record<BBHost, string>>;

/**
 * Production origins. Override per-surface via `AuthContext.hosts` or the
 * transport's `hosts` config — that is how a dev/QA environment is selected,
 * rather than by branching in here.
 */
export const DEFAULT_HOSTS: BBHosts = {
  blocky: OAUTH_BACKEND_URL,
  integrations: INTEGRATIONS_BASE_URL,
  agentic: AGENTIC_BASE_URL,
  // The Zitadel authority. A host like any other (PDEV-7339), not a special
  // case: self-hosted deployments run their own, and Zitadel's Hosted Login v2
  // introduces a custom base URL. Modelling it as a host rather than letting
  // token calls pass absolute URLs is what keeps b2b's proxy rewrite — and every
  // adapter's timeout, retry and custom headers — covering auth too. Auth is the
  // call you least want on a different code path from everything else.
  auth: AUTH_AUTHORITY,
};
