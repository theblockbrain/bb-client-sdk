import type { AuthContext } from "../settings/auth-mode.js";
import { requestJson } from "./_send.js";
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
  // This runs BEFORE an AuthContext exists — it is what decides whether the key
  // is usable at all — so it assembles the minimum the transport needs. `baseUrl`
  // becomes the blocky host, which is the point: an api-key user is typically on
  // their own instance.
  const ctx: AuthContext = { baseUrl, token, orgId: "", mode: "api-key" };
  const data = await requestJson<IntrospectResponse>(ctx, {
    host: "blocky",
    path: endpoint,
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (data.active !== true) throw new BBApiError("API key is inactive", 401, { endpoint });

  return data;
}

/** Pull the Zitadel org ID from an introspect response. Returns "" when absent. */
export function extractOrgIdFromIntrospect(data: IntrospectResponse): string {
  const val = data["urn:zitadel:iam:user:resourceowner:id"];
  return typeof val === "string" ? val : "";
}
