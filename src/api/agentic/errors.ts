/**
 * Terminal conditions of an Agentic turn that are not HTTP failures.
 *
 * These are protocol-level outcomes: the request succeeded, bytes streamed, and
 * then the turn ended in a state that is *not* a completed answer. They are
 * deliberately NOT `BBApiError` — there is no status code, nothing to retry at
 * the transport layer, and consumers branching on `isBBApiError` to render a
 * network banner would render the wrong thing.
 */
import type { AgenticErrorCode, AgenticErrorCodeValue } from "./types.js";

/**
 * Why an Agentic turn ended without a complete answer.
 *
 * - `tool-call-too-large`      — the model ran out of output tokens mid-tool-call.
 *   Resuming regenerates the same oversized call, so the turn stops instead.
 * - `server-error`             — the server emitted a structured `data-error` frame.
 * - `resume-budget-exhausted`  — `maxAutoResumes` resume cycles were used up.
 * - `multiple-suspends`        — the model suspended on more than one tool in a
 *   single step. A resume answers exactly one, so continuing would run one tool,
 *   drop the other, and leave the model reporting both as done.
 */
export type AgenticStreamErrorReason =
  | "tool-call-too-large"
  | "server-error"
  | "resume-budget-exhausted"
  | "multiple-suspends";

/**
 * An Agentic turn terminated before producing a complete answer.
 *
 * Thrown rather than returned because the alternative — the `break` this
 * replaced — made a truncated run **indistinguishable from a completed one**.
 * `createMessageStream` rejects `final` and re-throws into `textDeltas`, so
 * `useChatStream` takes its error path instead of committing a partial answer
 * to the message cache as if the assistant had finished speaking.
 *
 * Any text that streamed before the failure has already been yielded to the
 * caller; `partial` records whether that happened, so a surface can choose to
 * keep what it rendered rather than discard it.
 */
export class AgenticStreamError extends Error {
  readonly reason: AgenticStreamErrorReason;
  /** True when text was already streamed to the caller before the turn failed. */
  readonly partial: boolean;
  /**
   * Server error code — present only when `reason` is `server-error`.
   *
   * Typed as the open {@link AgenticErrorCodeValue} rather than the closed
   * {@link AgenticErrorCode}: it comes straight off the wire unvalidated, so a
   * closed union would let a `switch` claim exhaustiveness it does not have.
   */
  readonly code?: AgenticErrorCodeValue;
  /** Server trace id for support — present only when `reason` is `server-error`. */
  readonly traceId?: string;
  /** Whether a blind retry could plausibly succeed. */
  readonly retryable: boolean;
  /** Offending tool — present only when `reason` is `tool-call-too-large`. */
  readonly toolName?: string;

  constructor(
    message: string,
    reason: AgenticStreamErrorReason,
    options?: {
      partial?: boolean;
      code?: AgenticErrorCodeValue;
      traceId?: string;
      retryable?: boolean;
      toolName?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "AgenticStreamError";
    this.reason = reason;
    this.partial = options?.partial ?? false;
    this.code = options?.code;
    this.traceId = options?.traceId;
    this.retryable = options?.retryable ?? false;
    this.toolName = options?.toolName;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Preserve prototype for instanceof across bundler realms — same reason as
    // BBApiError: a Lit bundle and an add-in bundle can hold separate copies.
    Object.setPrototypeOf(this, AgenticStreamError.prototype);
  }
}

/** Type guard for {@link AgenticStreamError}. */
export function isAgenticStreamError(err: unknown): err is AgenticStreamError {
  return err instanceof AgenticStreamError;
}
