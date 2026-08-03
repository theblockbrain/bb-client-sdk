import { INTEGRATIONS_API_PREFIX } from "../config.js";
import type { AuthContext } from "../settings/auth-mode.js";
import { type AdminListingOptions, adminListingParams, bbApiAuthHeaders } from "./_auth-headers.js";
import { requestJson } from "./_send.js";
import type { MutationAckResponse } from "./mutation-ack.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A tenant's on/off switches for one capability.
 *
 * Renamed from `Capability` (PDEV-7684), for the same reason as {@link AgentSwitch}:
 * Botticelli's `@botticelli/capabilities` uses "capability" for the grantable RBAC
 * primitive, and this is the admin toggle for one — not the same noun.
 */
export interface CapabilitySwitch {
  id: string;
  name: string;
  active: boolean;
  available: boolean;
}

/** Switch state keyed by capability id. */
export type CapabilitySwitchesResponse = Record<string, CapabilitySwitch>;

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── API functions ─────────────────────────────────────────────────────────────

/**
 * Fetch the capabilities visible to the caller.
 * `GET {integrations}/api/v1/capabilities?orgId=...`
 *
 * Returns the tenant's active, available capabilities by default.
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 *   For cross-tenant admin calls, pass the target's orgId while ctx.orgId
 *   remains the user's home org (used for x-zitadel-org-id header auth).
 * @param options - {@link AdminListingOptions}. **Admin-only** — `capabilityStatusRoutesV1`
 *   carries the same `requireRole` gate as the agents route, so a non-admin token gets
 *   a 403. PDEV-7332 described the defect on agents only; it was on both.
 */
export async function fetchCapabilities(
  ctx: AuthContext,
  targetOrgId?: string,
  options?: AdminListingOptions,
): Promise<CapabilitySwitchesResponse> {
  return requestJson<CapabilitySwitchesResponse>(ctx, {
    host: "integrations",
    path: `${INTEGRATIONS_API_PREFIX}/capabilities`,
    method: "GET",
    query: { orgId: targetOrgId ?? ctx.orgId, ...adminListingParams(options) },
    headers: bbApiAuthHeaders(ctx),
  });
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
): Promise<MutationAckResponse> {
  return requestJson<MutationAckResponse>(ctx, {
    host: "integrations",
    path: `${INTEGRATIONS_API_PREFIX}/capabilities/set-active`,
    method: "PATCH",
    query: { orgId: targetOrgId ?? ctx.orgId },
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ capabilityId, active }),
  });
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
): Promise<MutationAckResponse> {
  return requestJson<MutationAckResponse>(ctx, {
    host: "integrations",
    path: `${INTEGRATIONS_API_PREFIX}/capabilities/set-availability`,
    method: "PATCH",
    query: { orgId: targetOrgId ?? ctx.orgId },
    headers: { "Content-Type": "application/json", ...bbApiAuthHeaders(ctx) },
    body: JSON.stringify({ capabilityId, available, orgId: targetOrgId ?? ctx.orgId }),
  });
}
