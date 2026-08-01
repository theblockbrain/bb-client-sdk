/**
 * Agentic API client — POST to the agent stream endpoint, handle SSE, resume loop.
 *
 * Entry point: `callAgenticStream` — returns an `AsyncIterable<string>` of text
 * deltas (transparent to both buffered and streaming callers).
 *
 * Tool-call approval and suspend events are intercepted here and handled via the
 * `ApprovalResolver` interface (default: auto-approve). The resume loop re-POSTs
 * to the same endpoint with `runId` + `resumeData` until the stream terminates
 * without a suspend/approval event.
 */
import { AGENTIC_BASE_URL } from "../../config.js";
import type { AuthContext } from "../../settings/auth-mode.js";
import { request } from "../_send.js";
import { BBApiError } from "../errors.js";
import type { Transporter } from "../transport.js";
import { normalizeUrl } from "../url.js";
import { agenticHeaders } from "./headers.js";
import { parseAgenticStream } from "./sse.js";
import {
  type AgenticRequestBody,
  type AgenticResumeData,
  type AgenticSseFrame,
  type AgenticUIMessage,
  isTextDeltaFrame,
  isToolCallApprovalFrame,
  isToolCallSuspendedFrame,
} from "./types.js";

// ─── ApprovalResolver ─────────────────────────────────────────────────────────

/**
 * Approval context passed to the resolver on a tool-call-approval event.
 * Shape mirrors the `data` payload of the `data-tool-call-approval` SSE frame.
 */
export interface ApprovalContext {
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  [key: string]: unknown;
}

/**
 * Suspension context passed to the resolver on a tool-call-suspended event.
 * The resolver must return an answer map or signal cancellation.
 */
export interface SuspendContext {
  runId?: string;
  toolCallId?: string;
  [key: string]: unknown;
}

export interface ApprovalResult {
  approved: boolean;
}

export interface SuspendResult {
  answers?: Record<string, string>;
  cancelled?: boolean;
}

/**
 * Strategy interface for handling tool-call approval and ask-user-question events.
 *
 * The agent backend emits a `data-tool-call-approval` frame and WAITS for an
 * answer — that frame is a real gate, and this resolver is what answers it.
 * Implement it to put the decision in front of a human; a write-capable agent's
 * tools execute server-side (e.g. against a live Microsoft Graph mailbox), so
 * the answer is a security decision, not a formality.
 */
export interface ApprovalResolver {
  resolveApproval(ctx: ApprovalContext): Promise<ApprovalResult>;
  resolveSuspend(ctx: SuspendContext): Promise<SuspendResult>;
}

/**
 * Safe fallback: denies every tool call and cancels every ask-user-question.
 *
 * Used by `sendMessage` when a conversation turns out to route to the Agentic
 * backend and the caller supplied no resolver. Denying is not a silent no-op:
 * the turn resumes with `{approved: false}`, so the agent is told the call was
 * refused and can still answer in prose — the user gets a response explaining
 * the tool did not run, instead of a tool running unattended.
 *
 * Suspends are `cancelled` rather than answered with `{}`: fabricating an empty
 * answer would let the agent proceed as though a human had responded.
 */
export const denyAllResolver: ApprovalResolver = {
  resolveApproval(_ctx: ApprovalContext): Promise<ApprovalResult> {
    return Promise.resolve({ approved: false });
  },
  resolveSuspend(_ctx: SuspendContext): Promise<SuspendResult> {
    return Promise.resolve({ cancelled: true });
  },
};

/**
 * Explicit opt-in that approves everything unattended. **Never a default.**
 *
 * Legitimate only where the agent cannot mutate anything the caller cares about
 * — read/compute-only embeds, fixtures, tests. Passing this to a write-capable
 * agent re-creates the defect PDEV-7330 fixed: the backend offers a gate and the
 * client answers "yes" on the user's behalf.
 */
export const autoApproveResolver: ApprovalResolver = {
  resolveApproval(_ctx: ApprovalContext): Promise<ApprovalResult> {
    return Promise.resolve({ approved: true });
  },
  resolveSuspend(_ctx: SuspendContext): Promise<SuspendResult> {
    return Promise.resolve({ answers: {} });
  },
};

// ─── Public options ───────────────────────────────────────────────────────────

export interface AgenticCallOptions {
  token: string;
  orgId: string;
  /** Agentic agent ID (from `ConversationDetail.agent`). */
  agentId: string;
  /** Conversation ID — doubles as `threadId` for Mastra Memory. */
  convoId: string;
  /** Zitadel user ID (`Profile.sub`). Required — throws if absent. */
  userId: string;
  /** The new user message content to send. */
  content: string;
  /** Optional known botId for `X-BLOCKBRAIN-ACTIVE-BOT-ID`; omitted if not available. */
  botId?: string | null;
  /** Override AGENTIC_BASE_URL (for testing). */
  agenticBaseUrl?: string;
  /**
   * How tool-call approvals and ask-user-questions are answered. **Required** —
   * there is deliberately no default, because a default is a decision made on
   * the user's behalf (PDEV-7330). Supply a resolver that prompts a human, or
   * `denyAllResolver` / `autoApproveResolver` to say so explicitly.
   *
   * `sendMessage` keeps this optional and falls back to `denyAllResolver`,
   * because it only learns at runtime whether a conversation routes here.
   */
  approvalResolver: ApprovalResolver;
  /**
   * Maximum number of consecutive auto-resume cycles to prevent infinite loops.
   * Default: 3. Mirrors `MAX_AUTO_RESUMES` in v1-frontend AgenticChatBridge.
   */
  maxAutoResumes?: number;
  /**
   * Cancels the turn (PDEV-7339). An agentic run has no deadline — it can
   * legitimately last minutes — so this is the only way to end one early.
   */
  signal?: AbortSignal;
  /**
   * Transport override. Defaults to a `fetch` transport pointed at
   * {@link AgenticCallOptions.agenticBaseUrl}. Supply one for a runtime whose
   * global `fetch` cannot stream — React Native needs its XHR source here.
   */
  transport?: Transporter;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_AUTO_RESUMES = 3;

/**
 * Derive the full Agentic stream URL from the base URL.
 *
 * `https://agentic.theblockbrain.ai/api`
 * → `https://agentic.theblockbrain.ai/v2/api/agents/{agentId}/stream`
 */
export function buildAgenticStreamUrl(baseUrl: string, agentId: string): string {
  const v2Base = normalizeUrl(baseUrl).replace(/\/api\/?$/, "/v2/api");
  return `${v2Base}/agents/${encodeURIComponent(agentId)}/stream`;
}

/**
 * The stream route as a host-relative path, for the transport.
 *
 * {@link buildAgenticStreamUrl} stays for consumers that build the absolute URL
 * themselves; the transport resolves the origin from the `agentic` host, so it
 * needs only this.
 */
function agenticStreamPath(agentId: string): string {
  return `/v2/api/agents/${encodeURIComponent(agentId)}/stream`;
}

/** Build a minimal UIMessage for the new user turn. */
function makeUserMessage(content: string): AgenticUIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content,
    parts: [{ type: "text", text: content }],
  };
}

/**
 * Execute one POST to the Agentic stream endpoint.
 * Returns an async iterable of frames from the SSE response.
 * Throws `BBApiError` on non-2xx status.
 */
async function postAgenticStream(
  ctx: AuthContext,
  path: string,
  headers: Record<string, string>,
  body: AgenticRequestBody,
  signal: AbortSignal | undefined,
): Promise<AsyncIterable<AgenticSseFrame>> {
  const res = await request(ctx, {
    host: "agentic",
    path,
    method: "POST",
    headers,
    body: JSON.stringify(body),
    stream: true,
    signal,
  });

  if (!res.ok || !res.chunks) {
    let responseBody: unknown;
    try {
      responseBody = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new BBApiError(`Agentic API ${res.status} at ${path}`, res.status, {
      endpoint: path,
      responseBody,
    });
  }

  return parseAgenticStream(res.chunks);
}

/**
 * Call the Agentic stream endpoint and yield text deltas.
 *
 * Handles the resume loop for tool-call-approval and tool-call-suspended events
 * using the provided `ApprovalResolver` (default: auto-approve).
 *
 * The generator terminates when:
 * - The stream ends without an approval/suspend event (normal completion).
 * - `maxAutoResumes` consecutive resume cycles are exhausted.
 * - An error is thrown (propagated to the caller).
 *
 * Callers receive a clean `AsyncIterable<string>` of text deltas.
 */
export async function* callAgenticStream(options: AgenticCallOptions): AsyncIterable<string> {
  const {
    token,
    orgId,
    agentId,
    convoId,
    userId,
    content,
    botId,
    agenticBaseUrl = AGENTIC_BASE_URL,
    signal,
    transport,
    approvalResolver,
    maxAutoResumes = DEFAULT_MAX_AUTO_RESUMES,
  } = options;

  // The agentic protocol has no AuthContext of its own — it is called with a
  // token and an org. Assemble the minimum the transport needs, pointing the
  // `agentic` host at the configured base URL.
  const ctx: AuthContext = {
    // `baseUrl` seeds the `blocky` host in `_send.ts` and is never read here —
    // every request below sets `host: "agentic"`. Pointed at the agentic origin
    // rather than left blank so a stray blocky call would fail loudly on the
    // wrong origin instead of silently hitting production.
    baseUrl: agenticBaseUrl,
    token,
    orgId,
    mode: "oauth",
    userId,
    hosts: { agentic: agenticBaseUrl },
    transport,
  };
  const path = agenticStreamPath(agentId);
  const headers = agenticHeaders({
    token,
    orgId,
    organizationId: orgId,
    conversationId: convoId,
    botId,
  });

  // User message and request ID are created once and reused across resume turns.
  // A stable message id prevents the server from creating duplicate user-message
  // records if it persists the `messages` array on resume turns.
  const userMessage = makeUserMessage(content);
  const requestId = crypto.randomUUID();

  // Initial request body — only the new user message (server holds history via threadId)
  let body: AgenticRequestBody = {
    id: requestId,
    messages: [userMessage],
    threadId: convoId,
    resourceId: userId,
  };

  let resumeCount = 0;

  while (true) {
    const frames = await postAgenticStream(ctx, path, headers, body, signal);

    let approvalData: { runId?: string; toolCallId?: string; toolName?: string } | null = null;
    let suspendData: { runId?: string; toolCallId?: string } | null = null;

    for await (const frame of frames) {
      if (isTextDeltaFrame(frame)) {
        const delta = frame.textDelta ?? frame.delta ?? "";
        if (delta) yield delta;
        continue;
      }

      if (isToolCallApprovalFrame(frame)) {
        approvalData = frame.data;
        continue;
      }

      if (isToolCallSuspendedFrame(frame)) {
        suspendData = frame.data;
      }

      // All other frames (tool-input-start, message-start/stop, custom data events, unknown) — ignored
    }

    // After stream exhausted: check if we need to resume
    if (approvalData !== null) {
      if (resumeCount >= maxAutoResumes) break;
      resumeCount++;

      const result = await approvalResolver.resolveApproval(approvalData);
      const resumeData: AgenticResumeData = { approved: result.approved };

      // Resume body: stable message + id, plus runId + resumeData
      body = {
        id: requestId,
        messages: [userMessage],
        threadId: convoId,
        resourceId: userId,
        runId: approvalData.runId,
        resumeData,
      };
      continue;
    }

    if (suspendData !== null) {
      if (resumeCount >= maxAutoResumes) break;
      resumeCount++;

      const result = await approvalResolver.resolveSuspend(suspendData);
      const resumeData: AgenticResumeData = result.cancelled
        ? { __cancelled: true as const }
        : { answers: result.answers ?? {} };

      // Resume body: stable message + id, plus runId + resumeData
      body = {
        id: requestId,
        messages: [userMessage],
        threadId: convoId,
        resourceId: userId,
        runId: suspendData.runId,
        resumeData,
      };
      continue;
    }

    // No pending resume — stream completed normally
    break;
  }
}
