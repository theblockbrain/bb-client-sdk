import { getCryptoAdapter } from "../adapters/crypto.js";
import { failureStage, telemetryErrorCode } from "../analytics/error-code.js";
import { trackEvent } from "../analytics/index.js";
import { subFromAccessToken } from "../auth/jwt-claims.js";
import type { AuthContext } from "../settings/auth-mode.js";
import type { MessageFailedStage } from "../telemetry/taxonomy.js";
import type { Route } from "../telemetry/vocabulary.js";
import { request, requestJson, throwIfNotOk } from "./_send.js";
import type { ApprovalResolver } from "./agentic/client.js";
import { callAgenticStream, denyAllResolver } from "./agentic/client.js";
import { parseBlockySseStream } from "./blocky-sse.js";
import { getConversationDetail } from "./conversations.js";
import { authHeaders } from "./headers.js";
import type { MessageStream } from "./stream-result.js";
import { createMessageStream, type StreamTelemetry } from "./stream-result.js";

// ─── sendMessage ──────────────────────────────────────────────────────────────

interface SendMessageResponse {
  body?: { content?: string };
}

export interface SendMessageOptions {
  /** Enable streaming mode. Default: false. */
  enableStreaming?: boolean;
  /**
   * How tool-call approvals and ask-user-questions are answered on an Agentic turn.
   *
   * **Omitted, every tool call is DENIED** (and a diagnostic is logged naming the
   * agent). That is the safe default, not a convenient one: the backend emits
   * `data-tool-call-approval` and waits, the tool executes server-side against
   * something live, so answering it is a security decision. Denying is not a
   * silent no-op — the turn resumes with `{approved: false}` and the agent
   * usually still answers in prose.
   *
   * This option stays optional only because `sendMessage` learns at runtime
   * whether a conversation routes to Agentic at all; `callAgenticStream` requires
   * a resolver outright.
   *
   * Pass one that prompts a human, or state the choice explicitly with
   * `denyAllResolver` / `autoApproveResolver`. **`autoApproveResolver` is never a
   * default** — it approves unattended, which is legitimate only where the agent
   * cannot mutate anything the caller cares about (read-only embeds, fixtures,
   * tests). It was the default once; PDEV-7330 removed it as a P0, because the
   * backend was offering a gate and the client was answering "yes" on the user's
   * behalf.
   */
  approvalResolver?: ApprovalResolver;
  /**
   * Cancels the turn (PDEV-7339).
   *
   * `useChatStream().stop()` was best-effort until now: it stopped consuming and
   * bumped a run-id, but the request kept running server-side. The comment in
   * `use-chat-stream.tsx` marking the enable point refers to this field.
   *
   * A streamed turn is sent with no deadline — a long agent run legitimately
   * outlives any fixed one — so this signal is the only way to end it early.
   */
  signal?: AbortSignal;
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

async function getCachedConvoAgent(ctx: AuthContext, convoId: string): Promise<string | null> {
  const cached = convoDetailCache.get(convoId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.agent;
  }
  const detail = await getConversationDetail(ctx, convoId);
  const agent = detail.agent ?? null;
  convoDetailCache.set(convoId, { agent, cachedAt: Date.now() });
  return agent;
}

/**
 * `denyAllResolver` plus a diagnostic, for the case where a conversation routed
 * to the Agentic backend and the caller passed no `approvalResolver`.
 *
 * The warning fires only when the agent ACTUALLY requests a tool call or a
 * suspend — not on every send — so a conversation that never reaches for a tool
 * stays silent. It is bounded by `maxAutoResumes`, so it cannot become a loop of
 * log spam. No dedup state is kept: each refused call is worth its own line,
 * since each one is a tool that did not run.
 */
function warnAndDenyResolver(agentId: string): ApprovalResolver {
  const explain = (what: string, detail: string) =>
    console.warn(
      `[bb-sdk] Agentic ${what} DENIED for agent ${agentId}: no approvalResolver was ` +
        `passed to sendMessage, so the SDK refused on the user's behalf rather than ` +
        `approving unattended (${detail}). Pass an approvalResolver that prompts the ` +
        `user, or autoApproveResolver from "@theblockbrain/bb-client-sdk/agentic" if ` +
        `this agent genuinely cannot mutate anything.`,
    );

  return {
    resolveApproval(ctx) {
      explain("tool call", `tool: ${ctx.toolName ?? "unknown"}`);
      return denyAllResolver.resolveApproval(ctx);
    },
    resolveSuspend(ctx) {
      explain("ask-user-question", `toolCallId: ${ctx.toolCallId ?? "unknown"}`);
      return denyAllResolver.resolveSuspend(ctx);
    },
  };
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
  const startedAt = Date.now();

  // ── Routing: look up whether this conversation has an agent ─────────────────
  const agentId = await getCachedConvoAgent(ctx, convoId);

  // One id per send, used as `message_id` here and as `request_id` on every event
  // the resulting stream emits. That correlation is the whole point: without it a
  // `message_first_token` cannot be tied back to the turn that produced it, and
  // TTFT stops being attributable to a route, a tenant, or a bad release.
  const requestId = getCryptoAdapter().randomUUID();
  // Routing is decided at runtime from the conversation's agent, so the route is
  // only knowable here — not from the caller's options.
  const route: Route = agentId ? "agent" : "chat";
  const streamTelemetry: StreamTelemetry = {
    route,
    conversation_id: convoId,
    request_id: requestId,
    // From the SEND, not from stream creation. The agentic source is lazy, so its
    // request leg runs inside the stream's drain while Blocky's runs before it —
    // measuring from creation made `ttft_ms` mean two different things per route.
    startedAt,
  };
  // NEVER `content` — the taxonomy carries no message text, and this is the call
  // site where the temptation is greatest. `input_mode` is likewise absent: only
  // the surface knows whether this string was typed or dictated, and defaulting it
  // to "text" here would silently report every dictation as typing.
  trackEvent("message_sent", { conversation_id: convoId, message_id: requestId, route });

  // Every exit below this point must close the funnel. `message_sent` has already
  // fired, so a throw that emits nothing leaves a turn that was started and never
  // finished — indistinguishable, in Mixpanel, from a user who wandered off. The
  // streaming paths `return` a MessageStream and are closed by `stream-result.ts`
  // instead, which is why this catch only ever sees a synchronous failure.
  //
  // `stage` narrows as the send progresses, the same device `login.ts` uses: a
  // catch cannot tell how far it got, and the phase is the one genuinely useful
  // thing a coarse failure label can carry.
  let stage: MessageFailedStage = "send";
  try {
    if (agentId) {
      // ── Agentic path ──────────────────────────────────────────────────────────
      //
      // Resolve resourceId (Zitadel user sub) via three-tier fallback:
      //   1. ctx.userId — explicitly set by the caller (most reliable)
      //   2. sub decoded from the access-token JWT — covers callers that build
      //      AuthContext manually without threading a userId param through
      //      (chrome-addon, ms-outlook-addin without 0.15.0 upgrade, etc.)
      //   3. null → hard error (only when token carries no sub, e.g. api-key)
      //
      // We read ctx.token here because: (a) getAuthContext may have already
      // derived sub and set ctx.userId, but (b) some callers construct
      // AuthContext directly and bypass getAuthContext entirely.
      const resourceId = ctx.userId ?? subFromAccessToken(ctx.token) ?? null;
      if (!resourceId) {
        throw new Error(
          "Agentic API requires a Zitadel user ID. " +
            "Either pass `config.userId = profile.sub` to `getAuthContext`, or " +
            "ensure the access token is a Zitadel OAuth JWT (not an API key). " +
            "Agentic routing is not available in api-key mode.",
        );
      }

      const deltaSource = callAgenticStream({
        token: ctx.token,
        orgId: ctx.orgId,
        agentId,
        convoId,
        userId: resourceId,
        content,
        // botId is not available from /general-info; X-BLOCKBRAIN-ACTIVE-BOT-ID
        // is sent conditionally — absent here means the header is omitted.
        botId: null,
        // Deny by default (PDEV-7330). Routing to Agentic is decided at runtime from
        // the conversation's agent, so a caller cannot always know a resolver will be
        // needed — but "didn't know" must not mean "approve on the user's behalf".
        approvalResolver: options.approvalResolver ?? warnAndDenyResolver(agentId),
      });

      if (streaming) {
        return createMessageStream(deltaSource, streamTelemetry);
      }

      // Buffer all text-deltas into a final string.
      //
      // `stage` flips only once a delta has actually arrived. `callAgenticStream` is
      // an `async function*`, so the request is issued by the FIRST iteration of this
      // loop, not by the call above — advancing to "stream" before the loop labelled
      // a refused send (a 503 on the agentic endpoint) as a mid-stream death, which
      // sends anyone grouping failures by stage looking at the wrong subsystem.
      let text = "";
      for await (const delta of deltaSource) {
        stage = "stream";
        text += delta;
      }
      // The buffered path produces no stream events, so it closes its own funnel —
      // otherwise a non-streaming caller reports sends that never complete.
      trackEvent("message_completed", {
        route,
        request_id: requestId,
        duration_ms: Date.now() - startedAt,
        outcome: "success",
      });
      return text;
    }

    // ── Blocky path ──────────────────────────────────────────────────────────────
    const endpoint = "/cortex/completions/v2/user-input";
    const res = await request(ctx, {
      host: "blocky",
      path: endpoint,
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(ctx.token, ctx.orgId) },
      body: JSON.stringify({
        convoId,
        content,
        sessionId: getCryptoAdapter().randomUUID(),
        messageType: "user-question",
        enableStreaming: streaming,
      }),
      // A streamed turn gets no deadline — a long agent run legitimately outlives
      // any fixed one. Cancel it with `signal`.
      stream: streaming,
      signal: options.signal,
    });
    await throwIfNotOk(res, endpoint);

    if (streaming) {
      // Blocky returns `text/event-stream` when enableStreaming is true.
      // `chunks` is decoded text, so the parser never touches a ReadableStream —
      // which is what lets RN (XHR) and Lit (EventSource) supply one too.
      if (!res.chunks) throw new Error("Blocky returned empty body for streaming request.");
      return createMessageStream(parseBlockySseStream(res.chunks), streamTelemetry);
    }

    // Non-streaming: Blocky returns JSON with the full response in body.content.
    // The status was already accepted by `throwIfNotOk`, so a failure from here is
    // the payload not being what was promised — `parse`, not `send`.
    stage = "parse";
    const data = await res.json<SendMessageResponse>();
    if (!data?.body?.content) throw new Error("No response received from bot.");
    trackEvent("message_completed", {
      route,
      request_id: requestId,
      duration_ms: Date.now() - startedAt,
      outcome: "success",
    });
    return data.body.content;
  } catch (err) {
    // Both, and not redundant. `message_failed` is the diagnostic — WHY and WHERE,
    // in closed vocabularies. `message_completed{outcome:"error"}` is the funnel's
    // denominator; without it the success rate is computed over successes alone and
    // reads 100% while every send fails.
    trackEvent("message_failed", {
      route,
      stage: failureStage(err, stage),
      error_code: telemetryErrorCode(err),
    });
    trackEvent("message_completed", {
      route,
      request_id: requestId,
      duration_ms: Date.now() - startedAt,
      outcome: "error",
    });
    // Re-thrown unchanged: telemetry observes the failure, it does not absorb it.
    throw err;
  }
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
  // A POST, but a read: the filter set is too large for a query string, so the
  // list endpoint takes a body. In scope for PDEV-7337 because nothing mutates.
  const data = await requestJson<{ body: MessageListBody }>(ctx, {
    host: "blocky",
    path: "/cortex/message/list",
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(ctx.token, ctx.orgId) },
    body: JSON.stringify({
      convoId,
      keyword: options.keyword ?? "",
      page: options.page ?? 1,
      size: options.size ?? 20,
    }),
  });
  return data.body;
}
