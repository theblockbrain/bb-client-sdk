/**
 * Agentic API header builder.
 *
 * Extends the base `authHeaders` (Authorization + x-zitadel-org-id) with the
 * BlockBrain-specific headers required by the Agentic streaming endpoint.
 *
 * Ref: v1-frontend AgenticV2Repository.ts — `createHeaders`.
 */
import { authHeaders } from "../headers.js";

export interface AgenticHeaderOptions {
  token: string;
  orgId: string;
  /** X-BLOCKBRAIN-ORGANIZATION-ID — same as orgId, different header name for Agentic. */
  organizationId: string;
  /** X-BLOCKBRAIN-DATA-ROOM-ID — the conversation / data room ID (= threadId). */
  conversationId: string;
  /**
   * X-BLOCKBRAIN-ACTIVE-BOT-ID — sent conditionally.
   * Omit (leave undefined) when not available from the conversation detail.
   * The Agentic server must handle its absence gracefully.
   */
  botId?: string | null;
}

/**
 * Build the full set of headers for an Agentic streaming POST.
 *
 * Sets Accept to `text/event-stream` in addition to the standard auth headers
 * so the response is treated as an SSE stream.
 */
export function agenticHeaders(options: AgenticHeaderOptions): Record<string, string> {
  const base = authHeaders(options.token, options.orgId);
  const headers: Record<string, string> = {
    ...base,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "X-BLOCKBRAIN-ORGANIZATION-ID": options.organizationId,
    "X-BLOCKBRAIN-DATA-ROOM-ID": options.conversationId,
  };
  if (options.botId) {
    headers["X-BLOCKBRAIN-ACTIVE-BOT-ID"] = options.botId;
  }
  return headers;
}
