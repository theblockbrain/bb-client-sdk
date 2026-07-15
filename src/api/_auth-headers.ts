import type { AuthContext } from "../settings/auth-mode.js";
import { BBApiError } from "./errors.js";

/**
 * Build auth headers for integrations.theblockbrain.ai (agents, capabilities, tenant-config).
 *
 * x-zitadel-org-id is ONLY sent for OAuth mode.
 * For api-key mode the header must be omitted — the integrations host uses a different
 * auth pipeline where the header causes a 500 (unlike blocky/* routes which always require it).
 */
export function bbApiAuthHeaders(ctx: AuthContext): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${ctx.token}`,
  };
  if (ctx.mode === "oauth") {
    headers["x-zitadel-org-id"] = ctx.orgId;
  }
  return headers;
}

/** Throw BBApiError on non-2xx responses. */
export async function throwIfNotOk(res: Response, endpoint: string): Promise<void> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      /* response may not be JSON */
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, {
      endpoint,
      responseBody: body,
    });
  }
}
