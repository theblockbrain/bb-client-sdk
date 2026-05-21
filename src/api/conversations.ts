import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";
import { BBApiError } from "./errors.js";
import type { AuthContext } from "../settings/auth-mode.js";

interface ConversationResponse {
  body: { dataRoomId: string };
}

/** Create a new conversation for a bot. Returns the conversation ID. */
export async function createConversation(
  ctx: AuthContext,
  botId: string,
  convoName = "BlockBrain Conversation",
): Promise<{ convoId: string }> {
  const endpoint = `/cortex/active-bot/${botId}/convo`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId),
    },
    body: JSON.stringify({ convoName }),
  });

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* response may not be JSON */ }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }

  const data = (await res.json()) as ConversationResponse;
  return { convoId: data.body.dataRoomId };
}

/**
 * Delete a conversation by ID.
 * Should be called in a finally block after each batch file pipeline to avoid
 * leaving orphaned conversations in the user's tenant.
 *
 * DELETE /cortex/conversation/:convoId
 */
export async function deleteConversation(
  ctx: AuthContext,
  convoId: string,
): Promise<void> {
  const endpoint = `/cortex/conversation/${convoId}`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "DELETE",
    headers: authHeaders(ctx.token, ctx.orgId),
  });

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* response may not be JSON */ }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }
}

export interface AttachmentUploadResult {
  _id: string;
  name: string;
  tokens: number;
  enabled: boolean;
  status?: string;
  createdAt: string;
  modifiedAt: string;
}

interface AttachmentUploadResponse {
  body?: AttachmentUploadResult;
}

/**
 * Upload a file as an attachment to an existing conversation.
 * The file is processed and made available as context for subsequent messages.
 *
 * POST /cortex/conversation/:convoId/attachment (multipart/form-data)
 * Field name: "attachment"
 *
 * @param file - A `File` (browser) or `Blob` with a `.name` property. In Bun/Node,
 *   pass `new File([buffer], filename, { type: mimeType })`.
 */
export async function uploadConversationAttachment(
  ctx: AuthContext,
  convoId: string,
  file: File | Blob,
): Promise<AttachmentUploadResult> {
  const endpoint = `/cortex/conversation/${convoId}/attachment`;
  const url = normalizeUrl(ctx.baseUrl);

  const form = new FormData();
  form.append("attachment", file);

  // Do NOT set Content-Type manually — the browser/runtime must set the
  // multipart boundary automatically when a FormData body is provided.
  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: authHeaders(ctx.token, ctx.orgId),
    body: form,
  });

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* response may not be JSON */ }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }

  const data = (await res.json()) as AttachmentUploadResponse;
  if (!data?.body) {
    throw new BBApiError("Attachment upload returned no body", res.status, { endpoint });
  }
  return data.body;
}
