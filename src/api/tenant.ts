import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";

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
