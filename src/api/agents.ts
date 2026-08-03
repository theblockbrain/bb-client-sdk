import { INTEGRATIONS_API_PREFIX } from "../config.js";
import type { AuthContext } from "../settings/auth-mode.js";
import { type AdminListingOptions, adminListingParams, bbApiAuthHeaders } from "./_auth-headers.js";
import { requestJson } from "./_send.js";
import type { MutationAckResponse } from "./mutation-ack.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A tenant's on/off switches for one agent.
 *
 * Renamed from `Agent` (PDEV-7684). This is **not** an agent you can run — it is
 * the admin toggle row that decides whether a tenant sees one. The runnable agent
 * lives in `./agentic`, which `./api` re-exports wholesale, so a bare `Agent`
 * imported from `./api` was genuinely ambiguous between "the thing that executes"
 * and "the checkbox that reveals it".
 */
export interface AgentSwitch {
  id: string;
  name: string;
  active: boolean;
  available: boolean;
  capabilityIds?: string[];
}

/** Switch state keyed by agent id. */
export type AgentSwitchesResponse = Record<string, AgentSwitch>;

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
): Promise<AgentSwitchesResponse> {
  return requestJson<AgentSwitchesResponse>(ctx, {
    host: "integrations",
    path: `${INTEGRATIONS_API_PREFIX}/agents`,
    method: "GET",
    query: { orgId: targetOrgId ?? ctx.orgId, ...adminListingParams(options) },
    headers: bbApiAuthHeaders(ctx),
  });
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
): Promise<MutationAckResponse> {
  return requestJson<MutationAckResponse>(ctx, {
    host: "integrations",
    path: `${INTEGRATIONS_API_PREFIX}/agents/set-active`,
    method: "PATCH",
    query: { orgId: targetOrgId ?? ctx.orgId },
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ agentId, active }),
  });
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
): Promise<MutationAckResponse> {
  return requestJson<MutationAckResponse>(ctx, {
    host: "integrations",
    path: `${INTEGRATIONS_API_PREFIX}/agents/set-availability`,
    method: "PATCH",
    query: { orgId: targetOrgId ?? ctx.orgId },
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ agentId, available, orgId: targetOrgId ?? ctx.orgId }),
  });
}
