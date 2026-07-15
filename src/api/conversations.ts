import type { AuthContext } from "../settings/auth-mode.js";
import { fetchBotDetail } from "./bots.js";
import { BBApiError } from "./errors.js";
import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";
import type { WebSearchConfig, WebSearchType } from "./websearch.js";

// ─── getConversationDetail ─────────────────────────────────────────────────────

/**
 * Subset of `ConvoGeneralInfoDTO` (blocky/src/api/nexus/conversation/schemas.py)
 * that the SDK needs for routing decisions.
 *
 * `agent` — when set, the conversation is wired to an Agentic agent and
 * `sendMessage` will route to the Agentic stream endpoint instead of Blocky.
 *
 * Note: `botId` is NOT returned by `/general-info` — the header
 * `X-BLOCKBRAIN-ACTIVE-BOT-ID` is sent conditionally and only when the caller
 * supplies it explicitly.
 */
export interface ConversationDetail {
  /** Agentic agent ID when the conversation has an agent configured; null/undefined otherwise. */
  agent?: string | null;
  /** Custom agent ID (separate from the Mastra agent ID in `agent`). */
  customAgentId?: string | null;
}

interface ConvoGeneralInfoDto {
  agent?: string | null;
  customAgentId?: string | null;
  [key: string]: unknown;
}

/**
 * The endpoint returns a CommonResponseDTO envelope: `{ code, key, body: ConvoGeneralInfoDto }`.
 * Some callers may also receive a flat (unwrapped) response — handle both.
 */
interface ConvoGeneralInfoResponse {
  body?: ConvoGeneralInfoDto;
  agent?: string | null;
  customAgentId?: string | null;
  [key: string]: unknown;
}

/**
 * Fetch lightweight conversation metadata used for routing.
 *
 * GET /cortex/conversation/{convoId}/general-info
 *
 * The response is intentionally narrow — only fields the SDK uses for internal
 * routing are surfaced; callers that need richer detail should use their own
 * frontend repository directly.
 */
export async function getConversationDetail(
  ctx: AuthContext,
  convoId: string,
): Promise<ConversationDetail> {
  const endpoint = `/cortex/conversation/${encodeURIComponent(convoId)}/general-info`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId),
  });

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

  const envelope = (await res.json()) as ConvoGeneralInfoResponse;
  // Backend wraps in CommonResponseDTO: { code, key, body: {...} }.
  // Fall back to top-level fields for callers that receive unwrapped responses.
  const data: ConvoGeneralInfoDto = envelope.body ?? envelope;
  return {
    agent: data.agent ?? null,
    customAgentId: data.customAgentId ?? null,
  };
}

interface ConversationResponse {
  body: { dataRoomId: string };
}

/**
 * Create a new conversation for a bot. Returns the conversation ID.
 *
 * Fetches the bot's `agent` field from `GET /cortex/active-bot/{botId}` and
 * includes it in the create payload when non-empty. This is required for
 * `sendMessage` to route to the Agentic path — the backend only persists
 * `agent` on the conversation when the field is present at create time.
 * Mirrors the behaviour of `CortexRepository.createConvoOfCortexBot` in
 * v1-frontend (spreads `options` including `agent` into the POST body).
 */
export async function createConversation(
  ctx: AuthContext,
  botId: string,
  convoName = "BlockBrain Conversation",
): Promise<{ convoId: string }> {
  // Fetch the bot's agent field so we can propagate it to the conversation.
  // A failed bot-detail fetch is non-fatal — we fall back to creating without
  // the agent field, which means the conversation routes via Blocky. This is
  // the safe degradation: better to work without Agentic routing than to fail
  // the whole create.
  let agentId: string | null = null;
  try {
    const botDetail = await fetchBotDetail(ctx, botId);
    agentId = botDetail.agent && botDetail.agent.length > 0 ? botDetail.agent : null;
  } catch {
    // Non-fatal: proceed without agent — Blocky routing applies
  }

  const endpoint = `/cortex/active-bot/${encodeURIComponent(botId)}/convo`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId),
    },
    body: JSON.stringify({
      convoName,
      ...(agentId !== null && { agent: agentId }),
    }),
  });

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
export async function deleteConversation(ctx: AuthContext, convoId: string): Promise<void> {
  const endpoint = `/cortex/conversation/${encodeURIComponent(convoId)}`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "DELETE",
    headers: authHeaders(ctx.token, ctx.orgId),
  });

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

  // Backend wraps in CommonResponseDTO: { code, key, body: AttachedFilesDTO }
  const envelope = (await res.json()) as AttachmentUploadEnvelope;
  const data = envelope.body;
  if (!data?._id || !data?.name) {
    throw new BBApiError("Attachment upload response missing required fields", res.status, {
      endpoint,
      responseBody: envelope,
    });
  }
  return data;
}

// ---------------------------------------------------------------------------
// GET /cortex/conversation/:convoId/attachment
// ---------------------------------------------------------------------------

interface ConversationAttachmentsEnvelope {
  body: AttachmentUploadResult[];
}

/**
 * Returns all attachments for a conversation.
 * Used to poll until the backend finishes processing uploaded files
 * (status transitions from "IN_PROGRESS" / "LOADING" to "COMPLETED" / "SUCCESS" / "FAILED").
 *
 * Status values observed in production (from v1-frontend constants):
 *   "IN_PROGRESS" | "LOADING"             — still processing
 *   "COMPLETED"   | "SUCCESS"             — ready for LLM use
 *   "ERROR"       | "FAILED"              — processing failed
 *
 * GET /cortex/conversation/:convoId/attachment
 */
export async function getConversationAttachments(
  ctx: AuthContext,
  convoId: string,
): Promise<AttachmentUploadResult[]> {
  const endpoint = `/cortex/conversation/${encodeURIComponent(convoId)}/attachment`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId),
  });

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

  // Response may be a plain array or wrapped in a CommonResponseDTO envelope
  const raw: unknown = await res.json();
  if (Array.isArray(raw)) return raw as AttachmentUploadResult[];
  const envelope = raw as ConversationAttachmentsEnvelope;
  return Array.isArray(envelope.body) ? envelope.body : [];
}

// ---------------------------------------------------------------------------
// PATCH /cortex/conversation/:convoId
// ---------------------------------------------------------------------------

/**
 * Partial-update patch for a conversation.
 * All fields are optional — only the fields present in the body are applied.
 *
 * Mirrors the `CortexConvoUpdateRequest` schema from
 * blocky/src/api/nexus/conversation/schemas.py.
 * Backend accepts camelCase aliases (populate_by_name=True + alias fields).
 *
 * Common use-cases:
 *  - Enable web search:  { enableWebSearch: true, webSearchType: "normal_web_search" }
 *  - Rename:             { name: "My Conversation" }
 *  - Swap model:         { model: "gpt-4o" }
 */
export interface UpdateConversationPatch {
  /** Rename the conversation. */
  name?: string;
  /** Enable/disable web search for this conversation. */
  enableWebSearch?: boolean;
  /**
   * Web search provider type. Values match the backend `WebSearchType` enum:
   * "normal_web_search" | "linkup_pro_web_search" | "linkup_pro_r_web_search" | …
   * Use the `WebSearchType` union from websearch.ts for safe values.
   */
  webSearchType?: WebSearchType;
  /** Fine-grained web search provider configuration (provider key, deep-search flag). */
  webSearchConfig?: WebSearchConfig;
  /** Enable semantic reranker for retrieval. */
  enableReranker?: boolean;
  /** Enable agentic retrieval mode. */
  enableAgentRetrieval?: boolean;
  /** Override the AI model for this conversation. */
  model?: string;
  /** Enable image generation responses. */
  enableGenerateImage?: boolean;
  /** Enable auto-response mode (bot replies without explicit send). */
  enableAutoResponse?: boolean;
  /** Response length preset. */
  lengthPreset?: string;
}

/**
 * Apply a partial update to an existing conversation.
 * Returns void — callers that need the updated state should re-fetch
 * via `getConversationWebSearch` or a dedicated GET endpoint.
 *
 * PATCH /cortex/conversation/{convoId}
 * Backend: blocky/src/api/nexus/conversation/routes.py — `update_convo_detail`
 */
export async function updateConversation(
  ctx: AuthContext,
  convoId: string,
  patch: UpdateConversationPatch,
): Promise<void> {
  const endpoint = `/cortex/conversation/${encodeURIComponent(convoId)}`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId),
    },
    body: JSON.stringify(patch),
  });

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
