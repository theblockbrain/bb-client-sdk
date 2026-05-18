import { normalizeUrl } from "./url.js";
import { bbApiAuthHeaders, throwIfNotOk } from "./_auth-headers.js";
import type { AuthContext } from "../settings/auth-mode.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TenantConfig {
  customAgentsEnabled: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Fetch tenant config for the org.
 * GET /tenants?orgId=...
 * Returns { id, name, config: { customAgentsEnabled, ... } | null }
 */
export async function getTenantConfig(ctx: AuthContext): Promise<TenantConfig> {
  const endpoint = "tenants";
  const base = normalizeUrl(ctx.baseUrl);
  const params = new URLSearchParams({ orgId: ctx.orgId });
  const url = `${base}/${endpoint}?${params.toString()}`;

  const res = await fetch(url, {
    method: "GET",
    headers: bbApiAuthHeaders(ctx),
  });
  await throwIfNotOk(res, endpoint);

  const data = (await res.json()) as { id: string; name: string; config: { customAgentsEnabled: boolean } | null };
  return { customAgentsEnabled: data.config?.customAgentsEnabled ?? false };
}

/**
 * Toggle the customAgentsEnabled flag for a tenant.
 * PATCH /tenants/config?orgId=...
 */
export async function setCustomAgentsEnabled(ctx: AuthContext, enabled: boolean): Promise<void> {
  const endpoint = "tenants/config";
  const base = normalizeUrl(ctx.baseUrl);
  const params = new URLSearchParams({ orgId: ctx.orgId });
  const url = `${base}/${endpoint}?${params.toString()}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ customAgentsEnabled: enabled }),
  });
  await throwIfNotOk(res, endpoint);
}
