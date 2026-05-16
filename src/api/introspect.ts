import { normalizeUrl } from "./url.js";

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
  const url = normalizeUrl(baseUrl);
  const res = await fetch(`${url}/auth/introspect_api_key`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = (await res.json()) as IntrospectResponse;
  if (data.active !== true) throw new Error("API key is inactive");

  return data;
}

/** Pull the Zitadel org ID from an introspect response. Returns "" when absent. */
export function extractOrgIdFromIntrospect(data: IntrospectResponse): string {
  const val = data["urn:zitadel:iam:user:resourceowner:id"];
  return typeof val === "string" ? val : "";
}
