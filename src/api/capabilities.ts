import { normalizeUrl } from "./url.js";
import { bbApiAuthHeaders, throwIfNotOk } from "./_auth-headers.js";
import type { AuthContext } from "../settings/auth-mode.js";
import type { ApiResponse } from "./agents.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Capability {
  id: string;
  name: string;
  active: boolean;
  available: boolean;
}

/** API response shape: Record<capabilityId, Capability> */
export type CapabilitiesResponse = Record<string, Capability>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildUrl(ctx: AuthContext, path: string, extra: Record<string, string> = {}): string {
  const base = normalizeUrl(ctx.baseUrl);
  const params = new URLSearchParams(extra);
  params.set("orgId", ctx.orgId);
  return `${base}/${path}?${params.toString()}`;
}

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Fetch all capabilities for the org (includes inactive and unavailable).
 * GET /capabilities?includeInactive=true&includeUnavailable=true&orgId=...
 */
export async function fetchCapabilities(ctx: AuthContext): Promise<CapabilitiesResponse> {
  const endpoint = "capabilities";
  const url = buildUrl(ctx, endpoint, { includeInactive: "true", includeUnavailable: "true" });
  const res = await fetch(url, {
    method: "GET",
    headers: bbApiAuthHeaders(ctx),
  });
  await throwIfNotOk(res, endpoint);
  return res.json() as Promise<CapabilitiesResponse>;
}

/**
 * Set the active flag for a single capability.
 * PATCH /capabilities/set-active?orgId=...
 */
export async function setCapabilityActive(
  ctx: AuthContext,
  capabilityId: string,
  active: boolean,
): Promise<ApiResponse> {
  const endpoint = "capabilities/set-active";
  const url = buildUrl(ctx, endpoint);
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ capabilityId, active }),
  });
  await throwIfNotOk(res, endpoint);
  return res.json() as Promise<ApiResponse>;
}

/**
 * Set the availability flag for a single capability.
 * PATCH /capabilities/set-availability?orgId=...
 */
export async function setCapabilityAvailability(
  ctx: AuthContext,
  capabilityId: string,
  available: boolean,
): Promise<ApiResponse> {
  const endpoint = "capabilities/set-availability";
  const url = buildUrl(ctx, endpoint);
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ capabilityId, available, orgId: ctx.orgId }),
  });
  await throwIfNotOk(res, endpoint);
  return res.json() as Promise<ApiResponse>;
}
