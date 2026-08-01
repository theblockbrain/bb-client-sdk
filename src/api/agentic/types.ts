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

export type AgenticResumeData = AgenticApprovalResumeData | AgenticAskUserQuestionResumeData;

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
 * Stable error identifiers emitted by the server's structured-error path
 * (`sse-error-emit.ts`). The server keeps this list closed deliberately — the
 * client renders copy from it — so it is a union here rather than `string`.
 */
export type AgenticErrorCode =
  | "TOOL_EXECUTION_FAILED"
  | "MASTRA_ERROR"
  | "HTTP_EXCEPTION"
  | "UNKNOWN_ERROR";

/** Payload of a {@link StreamErrorFrame}. Mirrors the server's `StructuredSseError`. */
export interface AgenticStreamErrorData {
  code: AgenticErrorCode;
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
