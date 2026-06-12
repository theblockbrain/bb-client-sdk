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

export type AgenticResumeData =
  | AgenticApprovalResumeData
  | AgenticAskUserQuestionResumeData;

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
