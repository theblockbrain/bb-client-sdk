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
 *
 * A suspend has two meanings and they share one frame type. If its `toolName` is one
 * the caller declared in `externalTools`, the model is asking the *client* to run that
 * tool — the add-in editing the open Word document, the embed reading the page — and
 * the loop resumes with its return value (PDEV-6627/PDEV-7919). Otherwise it is an
 * ask-user-question and goes to the resolver. Dispatching on the name is what keeps
 * the two apart; the server does not distinguish them for us.
 *
 * Any end that is not a completed answer throws `AgenticStreamError` — the
 * server's fail-fast signal, a structured server error, or an exhausted resume
 * budget. Ending quietly would make a truncated turn indistinguishable from a
 * short one, which is how a half-finished answer used to reach the message cache
 * labelled as final (PDEV-7333).
 */
import { getCryptoAdapter } from "../../adapters/crypto.js";
import { AGENTIC_BASE_URL } from "../../config.js";
import type { AuthContext } from "../../settings/auth-mode.js";
import { request } from "../_send.js";
import { BBApiError } from "../errors.js";
import type { Transporter } from "../transport.js";
import { normalizeUrl } from "../url.js";
import { AgenticStreamError } from "./errors.js";
import { agenticHeaders } from "./headers.js";
import { parseAgenticStream } from "./sse.js";
import {
  type AgenticApprovalResumeData,
  type AgenticAskUserQuestionResumeData,
  type AgenticExternalToolResumeData,
  type AgenticRequestBody,
  type AgenticSseFrame,
  type AgenticStreamErrorData,
  type AgenticUIMessage,
  type ConnectIntegrationData,
  type ExternalToolDef,
  isConnectIntegrationFrame,
  isStreamErrorFrame,
  isTextDeltaFrame,
  isToolCallApprovalFrame,
  isToolCallSuspendedFrame,
  isToolCallTooLargeFrame,
  isToolInputAvailableFrame,
  isToolOutputErrorFrame,
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
  /**
   * Which tool suspended, when the server reports it.
   *
   * Typed explicitly because the external-tool relay dispatches on it: a suspend
   * whose `toolName` matches a submitted {@link ExternalToolDef} is a request to run
   * that tool locally, not an ask-user-question.
   */
  toolName?: string;
  [key: string]: unknown;
}

export interface ApprovalResult {
  approved: boolean;
}

export interface SuspendResult {
  answers?: Record<string, string>;
  cancelled?: boolean;
}

// ─── External (client-executed) tools ─────────────────────────────────────────

/**
 * A model request to run one of the caller's own tools.
 *
 * Handed to {@link AgenticCallOptions.executeExternalTool}; the value it returns
 * becomes that tool's output for the model.
 */
export interface ExternalToolCall {
  /** Matches the `name` of one of the submitted {@link ExternalToolDef}s. */
  toolName: string;
  toolCallId?: string;
  runId?: string;
  /**
   * Arguments the model passed, captured from the `tool-input-available` frame for
   * this `toolCallId`.
   *
   * `undefined` when the server suspended without having emitted that frame — treat
   * it as "no arguments observed" rather than "no arguments passed", and prefer
   * failing the tool over guessing.
   */
  input: unknown;
  /** The raw `data-tool-call-suspended` payload, for fields this type does not model. */
  raw: Record<string, unknown>;
}

/**
 * Runs one client-executed tool and returns its result.
 *
 * Throwing is meaningful: the SDK converts a throw into a resume carrying an error
 * payload, so the model is told the tool failed and can react, rather than the turn
 * dying. Returning is equally meaningful — whatever comes back is handed to the model
 * verbatim as the tool's output.
 */
export type ExternalToolExecutor = (
  call: ExternalToolCall,
) => Promise<AgenticExternalToolResumeData>;

// ─── Observable non-terminal events ───────────────────────────────────────────

/**
 * A tool call executed and failed.
 *
 * Not terminal: the agent is told the tool failed and usually continues in
 * prose, so the turn still produces an answer. Reported so a surface can show
 * *which* step failed instead of silently rendering an answer that quietly
 * omits it.
 */
export interface ToolErrorEvent {
  toolCallId: string;
  /** Raw server-supplied error payload — shape is not guaranteed. */
  error: unknown;
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
   * Maximum number of resume cycles per turn, to bound a runaway loop.
   * Default: 3.
   *
   * **Cumulative for the whole turn, not consecutive** — the counter is never
   * reset, so this is a hard cap of 3 approvals/suspends per user message. The
   * previous "consecutive" wording described behaviour the code does not have;
   * `continue`/`break` are the only exits from the loop, so there is no point at
   * which a reset could occur.
   *
   * This diverges from the v1-frontend `AgenticChatBridge` it cites: there,
   * `MAX_AUTO_RESUMES` bounds only `finishReason: 'length'` continuations, and
   * the approval and suspend branches **reset the counter to 0** — a
   * human-in-the-loop gate is not a runaway-loop risk when a human clicks every
   * one. The SDK cannot assume a human: `autoApproveResolver` answers
   * unattended, so a bound on approvals is load-bearing here in a way it is not
   * in the browser. Whether to raise it, or to give approvals their own larger
   * budget, is a product decision — see PDEV-7333.
   *
   * Exhaustion is no longer silent: it throws {@link AgenticStreamError} with
   * `reason: "resume-budget-exhausted"`.
   */
  maxAutoResumes?: number;
  /**
   * Tools the caller executes itself (PDEV-6627). Presented to the model as native
   * tools; when it calls one the run suspends and
   * {@link AgenticCallOptions.executeExternalTool} runs it locally, then the SDK
   * resumes the run with its result.
   *
   * Sent on the initial request and re-sent on every resume — the server rebuilds
   * the relay tool per request, so dropping it mid-turn strands the suspended run.
   *
   * Only honoured for agents on the server's relay list (currently the WebComponent
   * Agent and the Word Agent). For any other agent the tools are shown to the model
   * but its calls are never relayed, so a suspend never arrives and the turn stalls
   * on the model's side.
   */
  externalTools?: ExternalToolDef[];
  /**
   * Runs a tool named in {@link AgenticCallOptions.externalTools}. Required to make
   * that array useful — without it a relayed call is answered as an
   * ask-user-question, which is not what the model asked for.
   */
  executeExternalTool?: ExternalToolExecutor;
  /**
   * Cap on client-executed tool calls per turn. Default: 32.
   *
   * Deliberately separate from {@link AgenticCallOptions.maxAutoResumes}, and much
   * larger. That budget bounds *unattended decisions* — each approval or answer the
   * SDK makes on a human's behalf — so keeping it small is the point. A relayed tool
   * call is not a decision: the model asked for data or an edit and the client
   * computed it, which is ordinary agent work. A document edit is a read-then-propose
   * loop that costs several calls, so charging them to a 3-resume budget would end
   * routine turns half-finished.
   *
   * Still bounded, because a model that loops on its own tool would otherwise spin
   * forever. Exhaustion throws {@link AgenticStreamError} with
   * `reason: "resume-budget-exhausted"`.
   */
  maxExternalToolCalls?: number;
  /**
   * Called when a tool call fails (`tool-output-error`). Non-terminal — the
   * stream continues. Optional; the SDK ignores tool failures without it.
   */
  onToolError?: (event: ToolErrorEvent) => void;
  /**
   * Called when a tool needs a Nango provider the user has not connected
   * (`data-connect-integration`). Non-terminal — the agent answers in prose.
   * Render an inline "Connect <provider>" card from this.
   */
  onConnectIntegration?: (event: ConnectIntegrationData) => void;
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
 * See {@link AgenticCallOptions.maxExternalToolCalls} for why this is far larger than
 * the resume budget: these are tool executions the model asked for, not decisions the
 * SDK made unattended.
 */
const DEFAULT_MAX_EXTERNAL_TOOL_CALLS = 32;

/**
 * Invoke a caller-supplied observer without letting it end the turn.
 *
 * `onToolError` / `onConnectIntegration` are notifications, not control flow —
 * they typically drive rendering. A throw from one (a setState on an unmounted
 * component, a bug in a Connect card) would otherwise propagate out of the frame
 * loop and abort an agent run that was still producing a perfectly good answer:
 * the observer would kill the thing it was only meant to watch.
 *
 * Swallowed silently, matching `trackEvent` in `./analytics` — the same
 * "instrumentation must never break the product flow" rule, applied to the same
 * category of callback.
 */
function notifyObserver<T>(observer: ((event: T) => void) | undefined, event: T): void {
  if (!observer) return;
  try {
    observer(event);
  } catch {
    // A consumer's observer must never break the stream it is observing.
  }
}

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
    id: getCryptoAdapter().randomUUID(),
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
 * - It throws {@link AgenticStreamError} — the turn ended without a complete
 *   answer (fail-fast tool-call, server error, or resume budget exhausted).
 * - It throws `BBApiError` — the request itself failed.
 *
 * Every abnormal end throws. Returning quietly would make a truncated turn look
 * like a short one, and `useChatStream` would commit it to the message cache as
 * the assistant's final answer.
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
    externalTools,
    executeExternalTool,
    maxExternalToolCalls = DEFAULT_MAX_EXTERNAL_TOOL_CALLS,
    onToolError,
    onConnectIntegration,
  } = options;

  // Relay dispatch is by name: a suspend whose toolName is in here is the model
  // asking the client to run that tool, not an ask-user-question. Empty unless the
  // caller supplied both the definitions and something to execute them — one without
  // the other cannot complete a relay, and half-handling it would answer the model's
  // tool call with an empty answers map.
  const relayToolNames =
    externalTools && executeExternalTool
      ? new Set(externalTools.map(tool => tool.name))
      : new Set<string>();

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
  const requestId = getCryptoAdapter().randomUUID();

  // Every request in the turn carries the same identity and the same relay tools.
  // Building resume bodies from this rather than by hand is what stops a resume from
  // silently dropping `externalTools` — the failure that strands a suspended run,
  // because the server rebuilds the relay tool per request.
  const baseBody = (): AgenticRequestBody => ({
    id: requestId,
    messages: [userMessage],
    threadId: convoId,
    resourceId: userId,
    ...(externalTools && externalTools.length > 0 ? { externalTools } : {}),
  });

  // Initial request body — only the new user message (server holds history via threadId)
  let body: AgenticRequestBody = baseBody();

  let resumeCount = 0;
  let externalToolCallCount = 0;
  // Tracks whether any text reached the caller, across every resume cycle — a
  // terminal failure after partial output is a different user experience from
  // one that produced nothing, and the surface decides what to do about it.
  let sawText = false;

  while (true) {
    const frames = await postAgenticStream(ctx, path, headers, body, signal);

    let approvalData: { runId?: string; toolCallId?: string; toolName?: string } | null = null;
    let suspendData: SuspendContext | null = null;
    let tooLargeToolName: string | null = null;
    let serverError: AgenticStreamErrorData | null = null;
    // Arguments seen this stream, keyed by toolCallId. The suspend frame names the
    // tool but is not guaranteed to repeat its arguments, so they are taken from the
    // `tool-input-available` frame that precedes it. Scoped per stream: a resume
    // re-emits the frames for the call it is resuming.
    const toolInputs = new Map<string, unknown>();

    for await (const frame of frames) {
      if (isTextDeltaFrame(frame)) {
        const delta = frame.textDelta ?? frame.delta ?? "";
        if (delta) {
          sawText = true;
          yield delta;
        }
        continue;
      }

      if (isToolCallApprovalFrame(frame)) {
        approvalData = frame.data;
        continue;
      }

      if (isToolInputAvailableFrame(frame)) {
        toolInputs.set(frame.toolCallId, frame.input);
        continue;
      }

      if (isToolCallSuspendedFrame(frame)) {
        suspendData = frame.data;
        continue;
      }

      if (isToolCallTooLargeFrame(frame)) {
        tooLargeToolName = frame.data?.toolName ?? "unknown";
        continue;
      }

      if (isStreamErrorFrame(frame)) {
        // Keep the last one: the server writes at most one, but if that ever
        // changes the most recent classification is the most specific.
        if (frame.data) serverError = frame.data;
        continue;
      }

      if (isToolOutputErrorFrame(frame)) {
        notifyObserver(onToolError, { toolCallId: frame.toolCallId, error: frame.error });
        continue;
      }

      // `data` is required by the server's contract, but the guard only checks
      // `type` — a malformed frame would otherwise hand the observer `undefined`
      // typed as a populated object, and the first property read would throw.
      if (isConnectIntegrationFrame(frame) && frame.data) {
        notifyObserver(onConnectIntegration, frame.data);
      }

      // All other frames (tool-input-start, message-start/stop, custom data events, unknown) — ignored
    }

    // ── Terminal conditions, checked before any resume ───────────────────────
    // Order matters: a fail-fast signal must win over a pending approval. The
    // server emits `data-tool-call-too-large` right before `finish`, so both can
    // be present in one stream — resuming on the approval would walk straight
    // into the wall the fail-fast exists to prevent.
    if (tooLargeToolName !== null) {
      throw new AgenticStreamError(
        `Agentic turn stopped: the model ran out of output tokens while generating a ` +
          `call to "${tooLargeToolName}", so the tool never ran. Resuming would ` +
          `regenerate the same oversized call. Split the request into smaller steps.`,
        "tool-call-too-large",
        { partial: sawText, toolName: tooLargeToolName },
      );
    }

    if (serverError !== null) {
      throw new AgenticStreamError(`Agentic turn failed: ${serverError.message}`, "server-error", {
        partial: serverError.partial || sawText,
        code: serverError.code,
        traceId: serverError.traceId,
        retryable: serverError.retryable,
      });
    }

    // After stream exhausted: check if we need to resume
    if (approvalData !== null) {
      if (resumeCount >= maxAutoResumes) {
        throw new AgenticStreamError(
          `Agentic turn stopped: the ${maxAutoResumes}-resume budget was exhausted with a ` +
            `tool call still awaiting approval. The answer so far is incomplete. ` +
            `Send a new message to continue.`,
          "resume-budget-exhausted",
          { partial: sawText },
        );
      }
      resumeCount++;

      const result = await approvalResolver.resolveApproval(approvalData);
      const resumeData: AgenticApprovalResumeData = { approved: result.approved };

      // Resume body: stable message + id + relay tools, plus runId + resumeData
      body = { ...baseBody(), runId: approvalData.runId, resumeData };
      continue;
    }

    if (suspendData !== null) {
      const toolName = typeof suspendData.toolName === "string" ? suspendData.toolName : undefined;

      // ── Client-executed tool (PDEV-6627 relay) ─────────────────────────────
      // Checked before the ask-user-question path: both arrive as the same frame
      // type, and only the tool name distinguishes "run this for me" from "ask the
      // user this". Answering a relayed call with an answers map would hand the
      // model an empty object where it expected its tool's output.
      if (toolName !== undefined && relayToolNames.has(toolName) && executeExternalTool) {
        if (externalToolCallCount >= maxExternalToolCalls) {
          throw new AgenticStreamError(
            `Agentic turn stopped: the ${maxExternalToolCalls}-call budget for client-executed ` +
              `tools was exhausted while running "${toolName}". The answer so far is incomplete.`,
            "resume-budget-exhausted",
            { partial: sawText },
          );
        }
        externalToolCallCount++;

        const toolCallId =
          typeof suspendData.toolCallId === "string" ? suspendData.toolCallId : undefined;
        let resumeData: AgenticExternalToolResumeData;
        try {
          resumeData = await executeExternalTool({
            toolName,
            toolCallId,
            runId: typeof suspendData.runId === "string" ? suspendData.runId : undefined,
            input: toolCallId !== undefined ? toolInputs.get(toolCallId) : undefined,
            raw: suspendData,
          });
        } catch (error) {
          // Resume with the failure rather than letting it escape. The run is
          // suspended server-side: throwing here abandons it, and the user loses a
          // turn because one tool failed. Telling the model instead lets it retry a
          // different way or explain what went wrong — the same courtesy the server
          // extends via `tool-output-error` for its own tools.
          resumeData = {
            error: error instanceof Error ? error.message : String(error),
          };
        }

        body = { ...baseBody(), runId: suspendData.runId, resumeData };
        continue;
      }

      if (resumeCount >= maxAutoResumes) {
        throw new AgenticStreamError(
          `Agentic turn stopped: the ${maxAutoResumes}-resume budget was exhausted while the ` +
            `agent was waiting on a user answer. The answer so far is incomplete. ` +
            `Send a new message to continue.`,
          "resume-budget-exhausted",
          { partial: sawText },
        );
      }
      resumeCount++;

      const result = await approvalResolver.resolveSuspend(suspendData);
      const resumeData: AgenticAskUserQuestionResumeData = result.cancelled
        ? { __cancelled: true as const }
        : { answers: result.answers ?? {} };

      // Resume body: stable message + id + relay tools, plus runId + resumeData
      body = { ...baseBody(), runId: suspendData.runId, resumeData };
      continue;
    }

    // No pending resume — stream completed normally
    break;
  }
}
