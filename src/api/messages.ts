import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";
import { BBApiError } from "./errors.js";
import { getConversationDetail } from "./conversations.js";
import { callAgenticStream } from "./agentic/client.js";
import { parseBlockySseStream } from "./blocky-sse.js";
import { createMessageStream, wrapStringAsStream } from "./stream-result.js";
import type { MessageStream } from "./stream-result.js";
import type { AuthContext } from "../settings/auth-mode.js";
import type { ApprovalResolver } from "./agentic/client.js";

// ─── sendMessage ──────────────────────────────────────────────────────────────

interface SendMessageResponse {
  body?: { content?: string };
}

export interface SendMessageOptions {
  /** Enable streaming mode. Default: false. */
  enableStreaming?: boolean;
  /**
   * Tool-call approval resolver for Agentic turns.
   * Default: `autoApproveResolver` (auto-approves all tool calls).
   * Replace to surface approval prompts to users without changing the call signature.
   */
  approvalResolver?: ApprovalResolver;
}

export interface SendMessageStreamOptions extends SendMessageOptions {
  enableStreaming: true;
}

// ─── Conversation detail cache ────────────────────────────────────────────────

interface CachedConvoDetail {
  agent: string | null;
  cachedAt: number;
}

/** Module-level cache — saves the extra GET on follow-up messages in the same session. */
const convoDetailCache = new Map<string, CachedConvoDetail>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getCachedConvoAgent(
  ctx: AuthContext,
  convoId: string,
): Promise<string | null> {
  const cached = convoDetailCache.get(convoId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.agent;
  }
  const detail = await getConversationDetail(ctx, convoId);
  const agent = detail.agent ?? null;
  convoDetailCache.set(convoId, { agent, cachedAt: Date.now() });
  return agent;
}

/** Evict a cached conversation (e.g. when the agent assignment changes). */
export function invalidateConvoDetailCache(convoId: string): void {
  convoDetailCache.delete(convoId);
}

// ─── Overload signatures ───────────────────────────────────────────────────────

/**
 * Send user input to a conversation and get the bot response.
 *
 * Routes automatically between Blocky and the Agentic API based on whether
 * the conversation has an agent configured — determined by a call to
 * `GET /cortex/conversation/{convoId}/general-info`.
 *
 * **Routing cache:** the agent assignment for each `convoId` is cached in memory
 * for up to 5 minutes. If the agent of a conversation is changed mid-session
 * (added or removed), routing continues to use the cached value until the TTL
 * expires. Call `invalidateConvoDetailCache(convoId)` after changing a
 * conversation's agent assignment to force an immediate re-fetch.
 *
 * @overload Non-streaming (default) — returns the full response as a string.
 */
export async function sendMessage(
  ctx: AuthContext,
  convoId: string,
  content: string,
  options?: SendMessageOptions & { enableStreaming?: false },
): Promise<string>;

/**
 * @overload Streaming — returns a `MessageStream` with `textDeltas` and `final`.
 * Both Blocky and Agentic paths produce the same shape; the Blocky path yields a
 * single-delta stream if the Blocky endpoint does not support true SSE.
 */
export async function sendMessage(
  ctx: AuthContext,
  convoId: string,
  content: string,
  options: SendMessageStreamOptions,
): Promise<MessageStream>;

// ─── Implementation ───────────────────────────────────────────────────────────

export async function sendMessage(
  ctx: AuthContext,
  convoId: string,
  content: string,
  options: SendMessageOptions = {},
): Promise<string | MessageStream> {
  const streaming = options.enableStreaming === true;

  // ── Routing: look up whether this conversation has an agent ─────────────────
  const agentId = await getCachedConvoAgent(ctx, convoId);

  if (agentId) {
    // ── Agentic path ──────────────────────────────────────────────────────────
    if (!ctx.userId) {
      throw new Error(
        "Agentic API requires OAuth context with a userId. " +
        "Pass `config.userId = profile.sub` to `getAuthContext` during login.",
      );
    }

    const deltaSource = callAgenticStream({
      token: ctx.token,
      orgId: ctx.orgId,
      agentId,
      convoId,
      userId: ctx.userId,
      content,
      // botId is not available from /general-info; X-BLOCKBRAIN-ACTIVE-BOT-ID
      // is sent conditionally — absent here means the header is omitted.
      botId: null,
      approvalResolver: options.approvalResolver,
    });

    if (streaming) {
      return createMessageStream(deltaSource);
    }

    // Buffer all text-deltas into a final string
    let text = "";
    for await (const delta of deltaSource) {
      text += delta;
    }
    return text;
  }

  // ── Blocky path ──────────────────────────────────────────────────────────────
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
      enableStreaming: streaming,
    }),
  });

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* response may not be JSON */ }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, { endpoint, responseBody: body });
  }

  if (streaming) {
    // Blocky returns `text/event-stream` when enableStreaming is true.
    // Parse the SSE format: `event: new_token` frames carry text deltas.
    if (!res.body) throw new Error("Blocky returned empty body for streaming request.");
    return createMessageStream(parseBlockySseStream(res.body));
  }

  // Non-streaming: Blocky returns JSON with the full response in body.content.
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
