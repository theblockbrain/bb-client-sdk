import type { AuthContext } from "../settings/auth-mode.js";
import { bbApiAuthHeaders, buildIntegrationsUrl, throwIfNotOk } from "./_auth-headers.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TenantConfig {
  customAgentsEnabled: boolean;
}

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Fetch tenant config for the org.
 * `GET {integrations}/api/v1/tenants?orgId=...`
 * Returns { id, name, config: { customAgentsEnabled, ... } | null }
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 *   For cross-tenant admin calls, pass the target's orgId while ctx.orgId
 *   remains the user's home org (used for x-zitadel-org-id header auth).
 */
export async function getTenantConfig(
  ctx: AuthContext,
  targetOrgId?: string,
): Promise<TenantConfig> {
  const endpoint = "tenants";
  const url = buildIntegrationsUrl(ctx, endpoint, targetOrgId);

  const res = await fetch(url, {
    method: "GET",
    headers: bbApiAuthHeaders(ctx),
  });
  await throwIfNotOk(res, endpoint);

  const data = (await res.json()) as {
    id: string;
    name: string;
    config: { customAgentsEnabled: boolean } | null;
  };
  return { customAgentsEnabled: data.config?.customAgentsEnabled ?? false };
}

/**
 * Toggle the customAgentsEnabled flag for a tenant.
 * `PATCH {integrations}/api/v1/tenants/config?orgId=...`
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 */
export async function setCustomAgentsEnabled(
  ctx: AuthContext,
  enabled: boolean,
  targetOrgId?: string,
): Promise<void> {
  const endpoint = "tenants/config";
  const url = buildIntegrationsUrl(ctx, endpoint, targetOrgId);

  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ customAgentsEnabled: enabled }),
  });
  await throwIfNotOk(res, endpoint);
}
