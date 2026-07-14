/**
 * Build auth headers for BlockBrain API requests.
 * x-zitadel-org-id is sent whenever orgId is provided — required for tenant isolation.
 *
 * NOTE: Does NOT set Content-Type. For JSON bodies callers add it explicitly;
 * for multipart/form-data (see uploadConversationAttachment) it must NOT be set
 * manually — the runtime derives the boundary from the FormData body automatically.
 */
export function authHeaders(token: string, orgId?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (orgId) {
    headers["x-zitadel-org-id"] = orgId;
  }
  return headers;
}
