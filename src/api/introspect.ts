import { normalizeUrl } from "./url.js";
import { BBApiError } from "./errors.js";

export interface IntrospectResponse {
  active: boolean;
  /** Zitadel resource-owner / org ID, required for multi-tenant endpoints like /sp2text. */
  "urn:zitadel:iam:user:resourceowner:id"?: string;
  [key: string]: unknown;
}

/**
 * Introspect an API key to verify it is active.
 * Only used in API-Key mode for connection testing.
 */
export async function introspectApiKey(
  baseUrl: string,
  token: string,
): Promise<IntrospectResponse> {
  const endpoint = "/auth/introspect_api_key";
  const url = normalizeUrl(baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* response may not be JSON */ }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }

  const data = (await res.json()) as IntrospectResponse;
  if (data.active !== true) throw new BBApiError("API key is inactive", 401, { endpoint });

  return data;
}

/** Pull the Zitadel org ID from an introspect response. Returns "" when absent. */
export function extractOrgIdFromIntrospect(data: IntrospectResponse): string {
  const val = data["urn:zitadel:iam:user:resourceowner:id"];
  return typeof val === "string" ? val : "";
}
