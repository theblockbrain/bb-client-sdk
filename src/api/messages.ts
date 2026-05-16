import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";
import { BBApiError } from "./errors.js";
import type { AuthContext } from "../settings/auth-mode.js";

// ─── sendMessage ──────────────────────────────────────────────────────────────

interface SendMessageResponse {
  body?: { content?: string };
}

export interface SendMessageOptions {
  /** Enable streaming mode. Default: false. */
  enableStreaming?: boolean;
}

/**
 * Send user input to a conversation and get the bot response.
 * Returns the response content string.
 */
export async function sendMessage(
  ctx: AuthContext,
  convoId: string,
  content: string,
  options: SendMessageOptions = {},
): Promise<string> {
  const endpoint = "/cortex/completions/v2/user-input";
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId),
    },
    body: JSON.stringify({
      convoId,
      content,
      sessionId: crypto.randomUUID(),
      messageType: "user-question",
      enableStreaming: options.enableStreaming ?? false,
    }),
  });

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* response may not be JSON */ }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }

  const data = (await res.json()) as SendMessageResponse;
  if (!data?.body?.content) throw new Error("No response received from bot.");

  return data.body.content;
}

// ─── getMessageList ───────────────────────────────────────────────────────────

export interface MessageItem {
  content: string;
  role: string;
  [k: string]: unknown;
}

export interface MessageListBody {
  data: MessageItem[];
  total?: number;
  page?: number;
}

export interface GetMessageListOptions {
  keyword?: string;
  page?: number;
  size?: number;
}

/**
 * Fetch paginated message history for a conversation.
 * POST /cortex/message/list
 *
 * Defaults: keyword="", page=1, size=20.
 */
export async function getMessageList(
  ctx: AuthContext,
  convoId: string,
  options: GetMessageListOptions = {},
): Promise<MessageListBody> {
  const endpoint = "/cortex/message/list";
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId),
    },
    body: JSON.stringify({
      convoId,
      keyword: options.keyword ?? "",
      page: options.page ?? 1,
      size: options.size ?? 20,
    }),
  });

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* response may not be JSON */ }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }

  const data = (await res.json()) as { body: MessageListBody };
  return data.body;
}
