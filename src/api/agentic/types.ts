/**
 * Agentic API types — AI SDK v6 UIMessage shape + SSE frame unions.
 *
 * Frame shapes derived from:
 *   - v1-frontend AgenticChatBridge.tsx (stream consumer)
 *   - v1-frontend AgenticV2Repository.ts (createHeaders)
 *   - AI SDK v6 DefaultChatTransport protocol
 */

// ─── UIMessage ─────────────────────────────────────────────────────────────────

/** Minimal UIMessage shape required by the Agentic request body. */
export interface AgenticUIMessage {
  /** Client-generated UUID for this message. */
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: AgenticMessagePart[];
}

export type AgenticMessagePart =
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

// ─── Request body ──────────────────────────────────────────────────────────────

/** Body sent to POST /v2/api/agents/{agentId}/stream */
export interface AgenticRequestBody {
  /** Client-generated request ID. */
  id: string;
  /** Only the new user message — server holds history via threadId (Mastra Memory). */
  messages: AgenticUIMessage[];
  /** Conversation ID — doubles as the Mastra thread ID. */
  threadId: string;
  /** Zitadel user ID (Profile.sub). */
  resourceId: string;
  /** Present on resume turns only. */
  runId?: string;
  /** Present on resume turns only. */
  resumeData?: AgenticResumeData;
  /**
   * Tools the client executes itself (PDEV-6627). Presented to the model as native
   * tools; when it calls one the run suspends (`data-tool-call-suspended`), the client
   * runs the tool locally and resumes with the result as `resumeData`.
   *
   * **Must be re-sent on every resume turn, not just the first.** The server rebuilds
   * the relay tool per request, so a resume that omits this array loses the tool the
   * run is suspended on.
   *
   * Honoured only for agents on the server's relay list. For any other agent the tools
   * are still shown to the model but its calls are never executed or relayed.
   */
  externalTools?: ExternalToolDef[];
}

/**
 * A tool the client executes, as declared to the server.
 *
 * Mirrors `externalToolSchema` in botticelli
 * (`packages/mastra-operators/src/mastra/api/util/external-toolset.ts`) — the server
 * validates against that and rejects the request with 400 on a mismatch.
 */
export interface ExternalToolDef {
  /** Tool name the model calls, and the key the suspend frame reports as `toolName`. */
  name: string;
  description: string;
  /** JSON Schema for the arguments; becomes the tool's `inputSchema` server-side. */
  parameters: Record<string, unknown>;
}

/** Resume payload for tool-call approval. */
export interface AgenticApprovalResumeData {
  approved: boolean;
}

/** Resume payload for ask-user-question. */
export interface AgenticAskUserQuestionResumeData {
  answers?: Record<string, string>;
  __cancelled?: true;
}

/**
 * Any JSON-encodable value — what actually crosses the wire in `resumeData`.
 *
 * Named rather than inlined as `unknown` so the resume-payload union below keeps
 * documenting its three cases instead of collapsing to "anything".
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Resume payload for a client-executed external tool: the tool's return value, which
 * the server hands to the model as that tool's output verbatim.
 *
 * Unlike the two fixed shapes above this is deliberately open — a Word tool may return
 * an object, a plain string, or a list, and the SDK does not reshape it.
 */
export type AgenticExternalToolResumeData = JsonValue;

export type AgenticResumeData =
  | AgenticApprovalResumeData
  | AgenticAskUserQuestionResumeData
  | AgenticExternalToolResumeData;

// ─── SSE Frame unions ──────────────────────────────────────────────────────────

/**
 * AI SDK v6 standard text streaming frames.
 * Ref: v1-frontend compiled bundle (AgenticChatBridge streaming consumer).
 */
export interface TextDeltaFrame {
  type: "text-delta";
  /** Primary field name in AI SDK v6. */
  textDelta?: string;
  /** Fallback alias observed in some server builds. */
  delta?: string;
}

export interface MessageStartFrame {
  type: "message-start";
  [key: string]: unknown;
}

export interface MessageStopFrame {
  type: "message-stop";
  [key: string]: unknown;
}

/** Tool execution frames (pass-through — not consumed by sendMessage core). */
export interface ToolInputStartFrame {
  type: "tool-input-start";
  toolCallId: string;
  toolName?: string;
}

export interface ToolInputAvailableFrame {
  type: "tool-input-available";
  toolCallId: string;
  toolName?: string;
  input?: unknown;
}

export interface ToolOutputAvailableFrame {
  type: "tool-output-available";
  toolCallId: string;
  output?: unknown;
}

export interface ToolOutputErrorFrame {
  type: "tool-output-error";
  toolCallId: string;
  error?: unknown;
}

// ─── Server fail-fast / diagnostic frames ──────────────────────────────────────

/**
 * The stream ended with the model still mid-tool-call.
 *
 * Emitted by mastra-operators immediately before the terminal `finish` chunk
 * when the model hit its output-token ceiling while generating a tool call, so
 * the tool never executed (`agent-stream-v2.ts` → `shouldEmitToolCallTooLarge`).
 *
 * **This frame must suppress auto-resume.** Resuming regenerates the same
 * oversized call and loops until the resume cap fires, leaving the user with
 * nothing — which is precisely the loop the server-side fail-fast exists to
 * prevent. `callAgenticStream` terminates the turn instead.
 */
export interface ToolCallTooLargeFrame {
  type: "data-tool-call-too-large";
  /** `toolName` falls back to `"unknown"` server-side when it cannot be resolved. */
  data?: { toolName?: string };
}

/**
 * The error identifiers the server emits today from its structured-error path
 * (`sse-error-emit.ts`), where the list is deliberately closed because the
 * client renders copy from it.
 *
 * Use this to type a copy map — `Record<AgenticErrorCode, string>` — so adding
 * a code is a compile error in the place that must handle it.
 *
 * **Do not use it as the type of a value read off the wire.** The server's list
 * being closed is a server-side discipline, not a runtime guarantee: the SDK
 * releases independently, `parseSseDataLine` casts parsed JSON without
 * validating it, and a server that adds `RATE_LIMITED` ships before any SDK
 * knows the name. Wire-facing fields are therefore typed
 * {@link AgenticErrorCodeValue}, which keeps the autocomplete but refuses to
 * promise exhaustiveness a `switch` cannot actually rely on.
 */
export type AgenticErrorCode =
  | "TOOL_EXECUTION_FAILED"
  | "MASTRA_ERROR"
  | "HTTP_EXCEPTION"
  | "UNKNOWN_ERROR";

/**
 * A code as it actually arrives: one of {@link AgenticErrorCode}, or any other
 * string a newer server sends.
 *
 * `(string & {})` is the open-enum idiom — it keeps editor completion for the
 * four known values while still accepting an unknown one, so a consumer's
 * `switch` needs a `default` and cannot silently drop a code the SDK predates.
 */
export type AgenticErrorCodeValue = AgenticErrorCode | (string & {});

/** Payload of a {@link StreamErrorFrame}. Mirrors the server's `StructuredSseError`. */
export interface AgenticStreamErrorData {
  code: AgenticErrorCodeValue;
  /** Originating error class name, for diagnostics. */
  errorClass: string;
  /**
   * Human-readable message. Already truncated (500 chars) and scrubbed
   * server-side — `UNKNOWN_ERROR` is replaced with a fixed generic string so an
   * unclassified error can never echo prompt or request content (PDEV-7075).
   */
  message: string;
  traceId: string;
  /** Whether a blind retry could plausibly succeed. */
  retryable: boolean;
  /** True when UI chunks were already written before the error — the turn is partial. */
  partial: boolean;
}

/**
 * A server-side error raised mid-stream.
 *
 * Without this frame the SSE pipe simply closes and every backend failure looks
 * like a short clean completion. `callAgenticStream` turns it into a thrown
 * {@link AgenticStreamError} so the failure cannot be committed as an answer.
 */
export interface StreamErrorFrame {
  type: "data-error";
  data?: AgenticStreamErrorData;
}

/** Payload of a {@link ConnectIntegrationFrame}. */
export interface ConnectIntegrationData {
  /** Nango provider unique key, e.g. `sharepoint_microsoft-tenant`. */
  providerKey: string;
  /** Tool id that triggered the prompt. */
  toolId: string;
  /** Mastra tool-call id that triggered the prompt, when available. */
  toolCallId?: string;
}

/**
 * A tool could not run because the user has not connected the required Nango
 * provider.
 *
 * This is a **graceful path, not an error**: the tool still returns
 * `{needsConnection: true, …}`, the agent is told not to retry, and it answers
 * in prose. The frame exists so the surface can render an inline "Connect
 * <provider>" card next to that prose. Treating it as a failure — or ignoring
 * it, as the SDK did — reduces a one-click fix to a bland sentence.
 */
export interface ConnectIntegrationFrame {
  type: "data-connect-integration";
  /** Server-generated part id, e.g. `connect:<toolCallId>:<providerKey>`. */
  id?: string;
  data: ConnectIntegrationData;
}

// ─── Custom BlockBrain data frames ─────────────────────────────────────────────

/** Signals that the agent requires tool-call approval to continue. */
export interface ToolCallApprovalFrame {
  type: "data-tool-call-approval";
  data: {
    runId?: string;
    toolCallId?: string;
    toolName?: string;
    [key: string]: unknown;
  };
}

/** Signals that the agent is suspended waiting for user input. */
export interface ToolCallSuspendedFrame {
  type: "data-tool-call-suspended";
  data: {
    runId?: string;
    toolCallId?: string;
    [key: string]: unknown;
  };
}

export interface CompressingFrame {
  type: "data-compressing";
  data?: { status?: "started" | "completed" | "failed" };
}

export interface IntelligentVectorSearchProgressFrame {
  type: "data-intelligent-vector-search-progress";
  data?: unknown;
}

export interface TodoUpdateFrame {
  type: "data-todo-update";
  data?: unknown;
}

/** Catch-all for frames the SDK does not specifically handle — always ignored. */
export interface UnknownFrame {
  type: string;
  [key: string]: unknown;
}

/**
 * Discriminated union of all known Agentic SSE frame types.
 *
 * The parser is tolerant: any frame whose `type` does not match a known
 * variant is typed as `UnknownFrame` and silently skipped by consumers.
 */
export type AgenticSseFrame =
  | TextDeltaFrame
  | MessageStartFrame
  | MessageStopFrame
  | ToolInputStartFrame
  | ToolInputAvailableFrame
  | ToolOutputAvailableFrame
  | ToolOutputErrorFrame
  | ToolCallTooLargeFrame
  | StreamErrorFrame
  | ConnectIntegrationFrame
  | ToolCallApprovalFrame
  | ToolCallSuspendedFrame
  | CompressingFrame
  | IntelligentVectorSearchProgressFrame
  | TodoUpdateFrame
  | UnknownFrame;

// ─── Type guards ───────────────────────────────────────────────────────────────

export function isTextDeltaFrame(frame: AgenticSseFrame): frame is TextDeltaFrame {
  return frame.type === "text-delta";
}

export function isToolCallApprovalFrame(frame: AgenticSseFrame): frame is ToolCallApprovalFrame {
  return frame.type === "data-tool-call-approval";
}

export function isToolCallSuspendedFrame(frame: AgenticSseFrame): frame is ToolCallSuspendedFrame {
  return frame.type === "data-tool-call-suspended";
}

/**
 * The frame that carries a tool call's arguments.
 *
 * Load-bearing for the external-tool relay: the `data-tool-call-suspended` frame
 * identifies *which* tool suspended (`toolName`, `toolCallId`, `runId`) but is not
 * guaranteed to repeat the arguments, so the client pairs it with the
 * `tool-input-available` frame that preceded it on the same `toolCallId`.
 */
export function isToolInputAvailableFrame(
  frame: AgenticSseFrame,
): frame is ToolInputAvailableFrame {
  return frame.type === "tool-input-available";
}

export function isToolOutputErrorFrame(frame: AgenticSseFrame): frame is ToolOutputErrorFrame {
  return frame.type === "tool-output-error";
}

export function isToolCallTooLargeFrame(frame: AgenticSseFrame): frame is ToolCallTooLargeFrame {
  return frame.type === "data-tool-call-too-large";
}

export function isStreamErrorFrame(frame: AgenticSseFrame): frame is StreamErrorFrame {
  return frame.type === "data-error";
}

export function isConnectIntegrationFrame(
  frame: AgenticSseFrame,
): frame is ConnectIntegrationFrame {
  return frame.type === "data-connect-integration";
}

/**
 * Attempt to parse a raw SSE `data:` line payload into a typed frame.
 * Returns `null` for the `[DONE]` sentinel, on parse error, or on empty input —
 * callers should skip null results. `[DONE]` does not itself stop iteration;
 * the stream ends when the underlying ReadableStream closes.
 */
export function parseSseDataLine(raw: string): AgenticSseFrame | null {
  if (!raw || raw === "[DONE]") return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.type !== "string") return null;
    // All variants carry `type` — return as-is; type guards narrow at call sites.
    return parsed as AgenticSseFrame;
  } catch {
    return null;
  }
}
