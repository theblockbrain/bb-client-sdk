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
  const endpoint = `/cortex/active-bot/${encodeURIComponent(botId)}/convo`;
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
  const endpoint = `/cortex/conversation/${encodeURIComponent(convoId)}`;
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

/**
 * Shape mirrors v1-frontend `UploadedFile` (lib/firestore-types.ts) plus
 * additional fields observed in the live API response.
 * Backend wraps the DTO in a CommonResponseDTO envelope: `{ code, key, body: AttachedFilesDTO }`.
 */
export interface AttachmentUploadResult {
  _id: string;
  name: string;
  tokens: number;
  enabled: boolean;
  createdAt: string;
  modifiedAt: string;
  status: string;
  success?: boolean;
  errorMessage?: string | null;
  calculatedStatus?: string;
  /** Detected file type, e.g. "TEXT", "IMAGE". */
  fileType?: string;
  url?: string | null;
  originUrl?: string | null;
  thumbUrl?: string | null;
  isDeleted?: boolean;
  /** Whether the file was processed with Smart OCR. */
  isSmartOcr?: boolean;
  /** Key used to detect and handle duplicate uploads. */
  uploadKey?: string | null;
  /** Conversation this attachment belongs to. */
  convoId?: string;
  /** Data room this attachment belongs to (when promoted). */
  dataroomId?: string | null;
  /** Whether the attachment has been permanently saved to a data room. */
  isSaved?: boolean;
  archivedAt?: string | null;
  dataRetentionConfig?: unknown;
}

interface AttachmentUploadEnvelope {
  code: number;
  key: string | null;
  body: AttachmentUploadResult;
}

/**
 * Optional parameters for `uploadConversationAttachment`.
 * All map directly to backend Form fields in `direct_upload_attachment`
 * (blocky/src/api/nexus/conversation/routes.py).
 * When omitted, the backend applies its own defaults.
 */
export interface UploadAttachmentOptions {
  /**
   * Run AWS Textract OCR on PDFs and images for higher-fidelity text extraction.
   * Backend default: true for PDF/image, false for plain text.
   */
  isSmartOcr?: boolean;
  /**
   * When a file with the same name already exists in the conversation:
   * keep both files side-by-side. Mutually exclusive with `isOverwriteDuplicate`.
   */
  isKeepBothDuplicate?: boolean;
  /**
   * When a file with the same name already exists in the conversation:
   * overwrite the existing file. Mutually exclusive with `isKeepBothDuplicate`.
   */
  isOverwriteDuplicate?: boolean;
  /**
   * Opaque key for grouping or deduplicating uploads on the server side.
   * Distinct from `sessionId` — used by callers that manage upload identity
   * independently of the session grouping.
   */
  uploadKey?: string;
}

/**
 * Upload a file as an attachment to an existing conversation.
 * The file is processed and made available as context for subsequent messages.
 *
 * POST /cortex/conversation/:convoId/attachment (multipart/form-data)
 * Backend route: blocky/src/api/nexus/conversation/routes.py — `direct_upload_attachment`
 *
 * @param file      - A `File` (browser) or `Blob` with a `.name` property. In Bun/Node,
 *                    pass `new File([buffer], filename, { type: mimeType })`.
 * @param sessionId - Fresh UUID per batch. Groups concurrent uploads in the backend
 *                    processing pipeline. Required by the backend.
 * @param options   - Optional upload behaviour overrides (OCR, duplicate handling, etc.).
 *
 * NOTE: Do NOT add `Content-Type` to the headers object — the multipart boundary
 * must be set by the runtime when a `FormData` body is provided. See `authHeaders`
 * in headers.ts for context.
 */
export async function uploadConversationAttachment(
  ctx: AuthContext,
  convoId: string,
  file: File | Blob,
  sessionId: string,
  options?: UploadAttachmentOptions,
): Promise<AttachmentUploadResult> {
  const endpoint = `/cortex/conversation/${encodeURIComponent(convoId)}/attachment`;
  const url = normalizeUrl(ctx.baseUrl);

  const form = new FormData();
  form.append("attachment", file);
  form.append("session_id", sessionId);

  if (options?.isSmartOcr !== undefined) {
    form.append("is_smart_ocr", String(options.isSmartOcr));
  }
  if (options?.isKeepBothDuplicate !== undefined) {
    form.append("is_keep_both_duplicate", String(options.isKeepBothDuplicate));
  }
  if (options?.isOverwriteDuplicate !== undefined) {
    form.append("is_overwrite_duplicate", String(options.isOverwriteDuplicate));
  }
  if (options?.uploadKey !== undefined) {
    form.append("upload_key", options.uploadKey);
  }

  // Do NOT set Content-Type here — the runtime sets the multipart boundary
  // automatically when a FormData body is provided. Manually setting
  // Content-Type would omit the boundary and cause a 422 on the server.
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

  // Backend wraps in CommonResponseDTO: { code, key, body: AttachedFilesDTO }
  const envelope = (await res.json()) as AttachmentUploadEnvelope;
  const data = envelope.body;
  if (!data?._id || !data?.name) {
    throw new BBApiError("Attachment upload response missing required fields", res.status, { endpoint, responseBody: envelope });
  }
  return data;
}
