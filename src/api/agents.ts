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

function buildUrl(ctx: AuthContext, path: string, extra: Record<string, string> = {}): string {
  const base = normalizeUrl(ctx.baseUrl);
  const params = new URLSearchParams(extra);
  params.set("orgId", ctx.orgId);
  return `${base}/${path}?${params.toString()}`;
}

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Fetch all agents for the org (includes inactive and unavailable).
 * GET /agents?includeInactive=true&includeUnavailable=true&orgId=...
 */
export async function fetchAgents(ctx: AuthContext): Promise<AgentsResponse> {
  const endpoint = "agents";
  const url = buildUrl(ctx, endpoint, {
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
 */
export async function setAgentActive(
  ctx: AuthContext,
  agentId: string,
  active: boolean,
): Promise<ApiResponse> {
  const endpoint = "agents/set-active";
  const url = buildUrl(ctx, endpoint, {});
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
 */
export async function setAgentAvailability(
  ctx: AuthContext,
  agentId: string,
  available: boolean,
): Promise<ApiResponse> {
  const endpoint = "agents/set-availability";
  const url = buildUrl(ctx, endpoint, {});
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ agentId, available, orgId: ctx.orgId }),
  });
  await throwIfNotOk(res, endpoint);
  return res.json() as Promise<ApiResponse>;
}
