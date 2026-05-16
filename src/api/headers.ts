/**
 * Build auth headers for BlockBrain API requests.
 * x-zitadel-org-id is sent whenever orgId is provided — required for tenant isolation.
 */
export function authHeaders(
  token: string,
  orgId?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (orgId) {
    headers["x-zitadel-org-id"] = orgId;
  }
  return headers;
}
