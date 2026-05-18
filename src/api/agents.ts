import { normalizeUrl } from "./url.js";
import { bbApiAuthHeaders, throwIfNotOk } from "./_auth-headers.js";
import type { AuthContext } from "../settings/auth-mode.js";

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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a URL for the agents/capabilities API.
 *
 * @param targetOrgId - Operation target org (i.e. ?orgId= query param).
 *   Falls back to ctx.orgId (user's home) for self-tenant operations.
 */
function buildUrl(
  ctx: AuthContext,
  path: string,
  targetOrgId: string | undefined,
  extra: Record<string, string> = {},
): string {
  const base = normalizeUrl(ctx.baseUrl);
  const params = new URLSearchParams(extra);
  params.set("orgId", targetOrgId ?? ctx.orgId);
  return `${base}/${path}?${params.toString()}`;
}

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Fetch all agents for the org (includes inactive and unavailable).
 * GET /agents?includeInactive=true&includeUnavailable=true&orgId=...
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 *   For cross-tenant admin calls, pass the target's orgId while ctx.orgId
 *   remains the user's home org (used for x-zitadel-org-id header auth).
 */
export async function fetchAgents(
  ctx: AuthContext,
  targetOrgId?: string,
): Promise<AgentsResponse> {
  const endpoint = "agents";
  const url = buildUrl(ctx, endpoint, targetOrgId, {
    includeInactive: "true",
    includeUnavailable: "true",
  });
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
  const url = buildUrl(ctx, endpoint, targetOrgId);
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
  const url = buildUrl(ctx, endpoint, targetOrgId);
  const effectiveOrgId = targetOrgId ?? ctx.orgId;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ agentId, available, orgId: effectiveOrgId }),
  });
  await throwIfNotOk(res, endpoint);
  return res.json() as Promise<ApiResponse>;
}
