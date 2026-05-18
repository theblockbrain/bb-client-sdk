import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";
import { BBApiError } from "./errors.js";
import type { AuthContext } from "../settings/auth-mode.js";

/**
 * Discover frontend URLs available for the authenticated tenant.
 * GET /user-tenant/domains
 *
 * Handles multiple response envelope shapes:
 *   { content: string[] }  — standard ResponseEntity
 *   { body: string[] }     — legacy envelope
 *   string[]               — flat array
 *
 * Returns null when the endpoint fails or returns no domains.
 */
export async function discoverFrontendUrls(
  baseUrl: string,
  token: string,
  orgId?: string | null,
): Promise<string[] | null> {
  const url = normalizeUrl(baseUrl);
  try {
    const res = await fetch(`${url}/user-tenant/domains`, {
      headers: {
        ...authHeaders(token, orgId),
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as { content?: string[]; body?: string[] } | string[];
    const domains =
      (raw as { content?: string[] }).content ??
      (raw as { body?: string[] }).body ??
      (Array.isArray(raw) ? raw : null);
    if (Array.isArray(domains) && domains.length > 0) return domains as string[];
    return null;
  } catch {
    return null;
  }
}

// ─── Tenant listing (admin-only) ──────────────────────────────────────────────
//
// Uses GET /tenant on the blocky host (confirmed live: 200, 213 tenants).
// This is the private_tenant_router in Botticelli; requires a master-org token.
//
// Response shape: ResponseEntity<TenantListDTO> — Botticelli wraps in
// { body: { totalCount, currentPage, data: TenantShortDTO[] } }.
//
// Note: TenantShortDTO does NOT include zitadelOrgId. To get that, call
// getTenantById(ctx, tenant.id) which hits GET /tenant/{id} and returns it
// via TenantAuthAndBotTemplateDTO. The list endpoint never exposes it.
//
// The fs-enabler used a different endpoint (GET /admin/tenants) on the
// integrations host — that host is separate and not part of our AuthContext.
// The blocky /tenant endpoint is the canonical admin list going forward.

export interface TenantSummary {
  /** MongoDB _id, mapped from the raw _id field. */
  id: string;
  tenantName: string;
  database: string;
  activePlan?: string;
  domain: string;
  acceptSuffix: string[];
}

export interface TenantDetail extends TenantSummary {
  /** Only available from getTenantById — not present in listTenants. */
  zitadelOrgId: string;
}

export interface ListTenantsResponse {
  totalCount: number;
  currentPage: number;
  data: TenantSummary[];
}

export interface ListTenantsOptions {
  /** Filter by tenant name (server-side substring match). Default: no filter. */
  name?: string;
  /** 1-based page number. Default: 1. */
  page?: number;
  /** Page size. Default: 20. */
  size?: number;
}

/**
 * List BB tenants. Admin-only — requires a token issued for the Blockbrain master org.
 * GET /tenant
 *
 * zitadelOrgId is NOT in the list response. If you need it for a specific tenant,
 * call getTenantById(ctx, tenant.id) to fetch it.
 */
export async function listTenants(
  ctx: AuthContext,
  options?: ListTenantsOptions,
): Promise<ListTenantsResponse> {
  const endpoint = "/tenant";
  const params = new URLSearchParams({
    name: options?.name ?? "",
    page: String(options?.page ?? 1),
    size: String(options?.size ?? 20),
  });
  const res = await fetch(`${normalizeUrl(ctx.baseUrl)}${endpoint}?${params}`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId),
  });

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* response may not be JSON */ }
    throw new BBApiError(`Tenant list failed: ${res.status}`, res.status, { endpoint, responseBody: body });
  }

  type RawTenant = { _id?: string; id?: string; tenantName: string; database: string; activePlan?: string; domain: string; acceptSuffix: string[] };
  type RawList = { totalCount: number; currentPage: number; data: RawTenant[] };
  const json = (await res.json()) as { body?: RawList } | RawList;
  const payload = (json as { body?: RawList }).body ?? (json as RawList);

  return {
    totalCount: payload.totalCount,
    currentPage: payload.currentPage,
    data: payload.data.map((t) => ({
      id: t._id ?? t.id ?? "",
      tenantName: t.tenantName,
      database: t.database,
      activePlan: t.activePlan,
      domain: t.domain,
      acceptSuffix: t.acceptSuffix ?? [],
    })),
  };
}

/**
 * Fetch full detail for a single tenant, including zitadelOrgId.
 * GET /tenant/{tenantId}
 *
 * Use this after listTenants when you need the zitadelOrgId to make
 * tenant-scoped API calls (x-zitadel-org-id header).
 */
export async function getTenantById(
  ctx: AuthContext,
  tenantId: string,
): Promise<TenantDetail> {
  const endpoint = `/tenant/${tenantId}`;
  const res = await fetch(`${normalizeUrl(ctx.baseUrl)}${endpoint}`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId),
  });

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* response may not be JSON */ }
    throw new BBApiError(`Tenant detail failed: ${res.status}`, res.status, { endpoint, responseBody: body });
  }

  type RawDetail = { _id?: string; id?: string; tenantName?: string; database: string; activePlan?: string; domain: string; acceptSuffix?: string[]; zitadelOrgId: string };
  const json = (await res.json()) as { body?: RawDetail } | RawDetail;
  const t = (json as { body?: RawDetail }).body ?? (json as RawDetail);

  return {
    id: t._id ?? t.id ?? "",
    tenantName: t.tenantName ?? "",
    database: t.database,
    activePlan: t.activePlan,
    domain: t.domain,
    acceptSuffix: t.acceptSuffix ?? [],
    zitadelOrgId: t.zitadelOrgId,
  };
}
