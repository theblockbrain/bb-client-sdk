import type { AuthContext } from "../settings/auth-mode.js";

/*
 * PDEV-7338 removed two things from this module:
 *
 * - `buildIntegrationsUrl`, superseded by the transport's own host resolution.
 *   The path prefix it applied is now `INTEGRATIONS_API_PREFIX` at each call site,
 *   and the `?orgId=` it appended is a `query` entry — both visible in the request
 *   rather than buried in a string builder.
 * - `throwIfNotOk(res: Response, ...)`, which was the SECOND error-normalisation
 *   path in the SDK. `_send.ts` now owns the only one. Two of them meant a
 *   non-2xx produced a differently-shaped `BBApiError` depending on which host
 *   you happened to call, which is precisely what stops `trackApiError` working
 *   without per-endpoint instrumentation (WS9).
 */

/**
 * Admin-only listing filters for agent and capability discovery.
 *
 * THE 403 FIX (PDEV-7332). `fetchAgents` and `fetchCapabilities` used to hardcode
 * both of these to `"true"`. Botticelli gates on exactly that, with an OR:
 *
 * ```ts
 * requireRole([Admin, SuperAdmin], {
 *   conditionFn: c => c.req.query('includeInactive') === 'true'
 *                  || c.req.query('includeUnavailable') === 'true',
 * })
 * ```
 *
 * (`agent-routes.ts` and `capability-routes.ts` — the gate is on **both**, though the
 * ticket only described it on agents.) So a normal user got a 403 from the one
 * endpoint carrying the `isConfigured` "connect X first" signal, and could not
 * discover agents at all.
 *
 * Omitted by default. Pass them only from an admin surface, and expect a 403 with a
 * non-admin token — that is the server behaving correctly, not a regression.
 */
export interface AdminListingOptions {
  /** Include agents/capabilities flagged inactive for the tenant. Admin-only. */
  includeInactive?: boolean;
  /** Include agents/capabilities flagged unavailable for the tenant. Admin-only. */
  includeUnavailable?: boolean;
}

/**
 * Serialise {@link AdminListingOptions} for the query string.
 *
 * A flag is emitted only when explicitly `true`. Sending `"false"` would be just as
 * unsafe as sending `"true"`: the server's `conditionFn` tests the raw query for
 * presence-and-value, so any explicit value keeps the caller on the admin branch.
 */
export function adminListingParams(options: AdminListingOptions = {}): Record<string, string> {
  return {
    ...(options.includeInactive === true ? { includeInactive: "true" } : {}),
    ...(options.includeUnavailable === true ? { includeUnavailable: "true" } : {}),
  };
}

/**
 * Build auth headers for integrations.theblockbrain.ai (agents, capabilities, tenant-config).
 *
 * x-zitadel-org-id is ONLY sent for OAuth mode.
 * For api-key mode the header must be omitted — the integrations host uses a different
 * auth pipeline where the header causes a 500 (unlike blocky/* routes which always require it).
 */
export function bbApiAuthHeaders(ctx: AuthContext): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${ctx.token}`,
  };
  if (ctx.mode === "oauth") {
    headers["x-zitadel-org-id"] = ctx.orgId;
  }
  return headers;
}
