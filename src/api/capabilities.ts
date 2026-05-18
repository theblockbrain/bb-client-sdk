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

/**
 * Build a URL for the capabilities API.
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
 * Fetch all capabilities for the org (includes inactive and unavailable).
 * GET /capabilities?includeInactive=true&includeUnavailable=true&orgId=...
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 *   For cross-tenant admin calls, pass the target's orgId while ctx.orgId
 *   remains the user's home org (used for x-zitadel-org-id header auth).
 */
export async function fetchCapabilities(
  ctx: AuthContext,
  targetOrgId?: string,
): Promise<CapabilitiesResponse> {
  const endpoint = "capabilities";
  const url = buildUrl(ctx, endpoint, targetOrgId, { includeInactive: "true", includeUnavailable: "true" });
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
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 */
export async function setCapabilityActive(
  ctx: AuthContext,
  capabilityId: string,
  active: boolean,
  targetOrgId?: string,
): Promise<ApiResponse> {
  const endpoint = "capabilities/set-active";
  const url = buildUrl(ctx, endpoint, targetOrgId);
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
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 */
export async function setCapabilityAvailability(
  ctx: AuthContext,
  capabilityId: string,
  available: boolean,
  targetOrgId?: string,
): Promise<ApiResponse> {
  const endpoint = "capabilities/set-availability";
  const url = buildUrl(ctx, endpoint, targetOrgId);
  const effectiveOrgId = targetOrgId ?? ctx.orgId;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ capabilityId, available, orgId: effectiveOrgId }),
  });
  await throwIfNotOk(res, endpoint);
  return res.json() as Promise<ApiResponse>;
}
