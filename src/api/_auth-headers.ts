import { INTEGRATIONS_API_PREFIX, INTEGRATIONS_BASE_URL } from "../config.js";
import type { AuthContext } from "../settings/auth-mode.js";
import { BBApiError } from "./errors.js";
import { normalizeUrl } from "./url.js";

/**
 * Build a URL on the integrations host.
 *
 * THE WRONG-HOST FIX (PDEV-7332). Every caller of this previously built its URL from
 * `normalizeUrl(ctx.baseUrl)`, and `getAuthContext` sets `baseUrl` to
 * `OAUTH_BACKEND_URL` — the blocky host. So `agents`, `capabilities` and
 * `tenant-config` were all pointed at a host that does not serve them, which is why
 * `useAgents` / `useCapabilities` / `useTenantConfig` could not work through a single
 * `BBClientProvider`.
 *
 * Two things were wrong, not one. Verified against Botticelli on 2026-07-29:
 * `packages/integrations/src/index.ts:227` mounts `app.route('/api/v1/', v1Router)`,
 * so the prefix was missing too. See {@link INTEGRATIONS_API_PREFIX}.
 *
 * Consolidated here because `agents.ts` and `capabilities.ts` each carried a
 * byte-identical private `buildUrl`, and `tenant-config.ts` a third inline variant —
 * three places to get the host wrong.
 *
 * @param path - Route path relative to the API prefix, no leading slash. e.g. `"agents/set-active"`.
 * @param targetOrgId - Operation target org (the `?orgId=` param). Falls back to
 *   `ctx.orgId` (the user's home org) for self-tenant operations. Distinct from the
 *   `x-zitadel-org-id` header, which always carries the home org.
 * @param extra - Additional query params.
 */
export function buildIntegrationsUrl(
  ctx: AuthContext,
  path: string,
  targetOrgId?: string,
  extra: Readonly<Record<string, string>> = {},
): string {
  const origin = normalizeUrl(ctx.hosts?.integrations ?? INTEGRATIONS_BASE_URL);
  const params = new URLSearchParams(extra);
  params.set("orgId", targetOrgId ?? ctx.orgId);
  return `${origin}${INTEGRATIONS_API_PREFIX}/${path}?${params.toString()}`;
}

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

/** Throw BBApiError on non-2xx responses. */
export async function throwIfNotOk(res: Response, endpoint: string): Promise<void> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      /* response may not be JSON */
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, {
      endpoint,
      responseBody: body,
    });
  }
}
