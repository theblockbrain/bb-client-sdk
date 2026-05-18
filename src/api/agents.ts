import { normalizeUrl } from "./url.js";
import { BBApiError } from "./errors.js";
import { bbApiAuthHeaders } from "./_auth-headers.js";
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

function agentsUrl(ctx: AuthContext, path: string): string {
  const base = normalizeUrl(ctx.baseUrl);
  const url = new URL(`${base}/${path}`, "http://placeholder");
  url.searchParams.set("orgId", ctx.orgId);
  // Preserve any existing path query params (e.g. includeInactive)
  return `${base}/${path}${url.search}`;
}

function agentsUrlWithExtra(ctx: AuthContext, path: string, extra: Record<string, string>): string {
  const base = normalizeUrl(ctx.baseUrl);
  // Build params manually to control ordering
  const params = new URLSearchParams(extra);
  params.set("orgId", ctx.orgId);
  return `${base}/${path}?${params.toString()}`;
}

async function throwIfNotOk(res: Response, endpoint: string): Promise<void> {
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* response may not be JSON */ }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
}

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Fetch all agents for the org (includes inactive and unavailable).
 * GET /agents?includeInactive=true&includeUnavailable=true&orgId=...
 */
export async function fetchAgents(ctx: AuthContext): Promise<AgentsResponse> {
  const endpoint = "agents";
  const url = agentsUrlWithExtra(ctx, endpoint, {
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
  const url = agentsUrlWithExtra(ctx, endpoint, {});
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
  const url = agentsUrlWithExtra(ctx, endpoint, {});
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ agentId, available, orgId: ctx.orgId }),
  });
  await throwIfNotOk(res, endpoint);
  return res.json() as Promise<ApiResponse>;
}
