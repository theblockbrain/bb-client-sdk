import type { AuthContext } from "../settings/auth-mode.js";
import {
  type AdminListingOptions,
  adminListingParams,
  bbApiAuthHeaders,
  buildIntegrationsUrl,
  throwIfNotOk,
} from "./_auth-headers.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  name: string;
  active: boolean;
  available: boolean;
  capabilityIds?: string[];
}

export interface ApiResponse {
  ok: boolean;
  error?: string;
}

/** API response shape: Record<agentId, Agent> */
export type AgentsResponse = Record<string, Agent>;

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Fetch the agents visible to the caller.
 * `GET {integrations}/api/v1/agents?orgId=...`
 *
 * Returns the tenant's active, available agents by default — the set a normal user
 * can actually use, and the response that carries the `isConfigured`
 * "connect X first" signal.
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 *   For cross-tenant admin calls, pass the target's orgId while ctx.orgId
 *   remains the user's home org (used for x-zitadel-org-id header auth).
 * @param options - {@link AdminListingOptions}. Both flags are **admin-only**: they
 *   put the request on Botticelli's Admin/SuperAdmin branch, so a non-admin token
 *   gets a 403. Omit them unless you are calling from an admin surface. Until
 *   PDEV-7332 these were hardcoded to `"true"`, which 403'd every normal user.
 */
export async function fetchAgents(
  ctx: AuthContext,
  targetOrgId?: string,
  options?: AdminListingOptions,
): Promise<AgentsResponse> {
  const endpoint = "agents";
  const url = buildIntegrationsUrl(ctx, endpoint, targetOrgId, adminListingParams(options));
  const res = await fetch(url, {
    method: "GET",
    headers: bbApiAuthHeaders(ctx),
  });
  await throwIfNotOk(res, endpoint);
  return res.json() as Promise<AgentsResponse>;
}

/**
 * Set the active flag for a single agent.
 * PATCH /agents/set-active?orgId=...
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 */
export async function setAgentActive(
  ctx: AuthContext,
  agentId: string,
  active: boolean,
  targetOrgId?: string,
): Promise<ApiResponse> {
  const endpoint = "agents/set-active";
  const url = buildIntegrationsUrl(ctx, endpoint, targetOrgId);
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ agentId, active }),
  });
  await throwIfNotOk(res, endpoint);
  return res.json() as Promise<ApiResponse>;
}

/**
 * Set the availability flag for a single agent.
 * PATCH /agents/set-availability?orgId=...
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 */
export async function setAgentAvailability(
  ctx: AuthContext,
  agentId: string,
  available: boolean,
  targetOrgId?: string,
): Promise<ApiResponse> {
  const endpoint = "agents/set-availability";
  const url = buildIntegrationsUrl(ctx, endpoint, targetOrgId);
  const effectiveOrgId = targetOrgId ?? ctx.orgId;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ agentId, available, orgId: effectiveOrgId }),
  });
  await throwIfNotOk(res, endpoint);
  return res.json() as Promise<ApiResponse>;
}
