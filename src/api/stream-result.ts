/**
 * Shared streaming result shape used by both the Blocky and Agentic send paths.
 *
 * `sendMessage` with `enableStreaming: true` resolves to this type regardless
 * of which backend handled the request — callers get a unified interface.
 *
 * This module is also where the stream half of the telemetry taxonomy is emitted,
 * because it is the one place both backends converge: instrumenting the Blocky
 * and Agentic paths separately would produce two funnels that drift.
 */

import { trackEvent } from "../analytics/index.js";
import type { StreamDropReason } from "../telemetry/taxonomy.js";
import type { Route } from "../telemetry/vocabulary.js";
import type { BBErrorKind } from "./errors.js";
import { isBBApiError } from "./errors.js";

/**
 * What the caller knows about the turn that a `MessageStream` cannot infer.
 *
 * Optional throughout: a stream built without it still works and simply emits
 * nothing. Telemetry must never be the reason a send path fails to compile.
 */
export interface StreamTelemetry {
  route: Route;
  conversation_id?: string;
  request_id?: string;
}

/**
 * `BBErrorKind` → the taxonomy's drop reason. The two vocabularies were designed
 * to line up, so the mapping is total rather than a lookup with a default.
 *
 * `http` is absent deliberately: it is the one kind where the status still decides
 * (a mid-stream 4xx is not a server fault), so it is handled at the call site.
 */
const KIND_TO_DROP_REASON: Readonly<Record<Exclude<BBErrorKind, "http">, StreamDropReason>> = {
  aborted: "client_abort",
  network: "network",
  timeout: "timeout",
  parse: "parse_error",
};

/** Below this, an HTTP status mid-stream is not the server's fault. */
const SERVER_ERROR_FLOOR = 500;

/**
 * Classify a stream failure into the taxonomy's closed reason vocabulary.
 *
 * Deliberately coarse and derived only from an error's SHAPE — never its message.
 *
 * **`kind` is read before `statusCode`, and that ordering is the whole point.**
 * `errors.ts` says it outright: "Check `BBApiError.kind` first when the
 * distinction matters: `statusCode` alone cannot tell a network drop from a
 * timeout — both report `0`." The transport does not re-throw the `AbortError` it
 * received either; `toTransportError` converts a caller abort into
 * `BBApiError{statusCode: 0, kind: "aborted"}`. So a classifier that tests
 * `name === "AbortError"` and then falls back to `statusCode` files EVERY
 * transport-level drop as `unknown` — and since a stream already got its 200
 * before it broke, transport-level is what almost every real drop is. That
 * silently empties `stream_dropped.reason`, makes `timeout` unreachable, and
 * folds user cancellations (which the taxonomy separates precisely so they do not
 * inflate the drop rate) in with genuine faults.
 *
 * The `instanceof` ladder is kept below for throws that never went through the
 * transport: `parseBlockySseStream` can raise a `SyntaxError`, a raw
 * `ReadableStream` can raise a native `AbortError`, and a bare `fetch` rejection
 * is a `TypeError`. Anything else is `unknown` rather than a guess, because a
 * wrong label is worse than an honest one when someone is paging on the number.
 */
function dropReason(error: unknown): StreamDropReason {
  if (isBBApiError(error)) {
    if (error.kind === "http") {
      return error.statusCode >= SERVER_ERROR_FLOOR ? "server_error" : "unknown";
    }
    return KIND_TO_DROP_REASON[error.kind];
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return "client_abort";
    if (error instanceof SyntaxError) return "parse_error";
    // Undici/browser `fetch` surfaces a dead connection as a bare TypeError.
    if (error instanceof TypeError) return "network";
  }
  return "unknown";
}

export interface MessageStream {
  /**
   * Async iterable that yields text deltas as they arrive.
   *
   * For Blocky without true SSE: yields a single string containing the full
   * response (the endpoint returns JSON, not a stream). The `final` promise
   * resolves to the same value.
   *
   * For Agentic: yields incremental `text-delta` chunks from the SSE stream.
   */
  textDeltas: AsyncIterable<string>;
  /**
   * Resolves to the fully assembled response text when the stream is complete.
   *
   * `final` resolves independently of whether `textDeltas` is consumed — it is
   * safe to await `final` without iterating `textDeltas`, and vice versa.
   * An internal drain runs automatically so callers are never deadlocked.
   *
   * Rejects if the underlying source throws during reading.
   */
  final: Promise<string>;
}

/**
 * Wrap a single pre-resolved string into a `MessageStream`.
 *
 * Used by the Blocky path when `enableStreaming: true` is requested but the
 * Blocky endpoint returns a JSON response (no actual SSE).
 */
export function wrapStringAsStream(text: string, telemetry?: StreamTelemetry): MessageStream {
  if (telemetry) {
    const { route, request_id, conversation_id } = telemetry;
    trackEvent("stream_started", { route, request_id, conversation_id });
    // `message_first_token` is deliberately NOT emitted here. This path is handed
    // an already-complete response, so the only "TTFT" it could report is 0 —
    // which would not be a fast turn, it would be a fabricated one, and it feeds
    // the same p95 the SSE path does. A missing sample is honest; a zero is not.
    trackEvent("message_completed", { route, request_id, outcome: "success" });
  }
  // `async` is required so the generator is an AsyncIterable (a plain generator
  // would only be Iterable and wouldn't satisfy MessageStream.textDeltas).
  // eslint-disable-next-line @typescript-eslint/require-await
  async function* singleDelta(): AsyncIterable<string> {
    yield text;
  }
  return {
    textDeltas: singleDelta(),
    final: Promise.resolve(text),
  };
}

/**
 * Build a `MessageStream` from an `AsyncIterable<string>` of text deltas.
 *
 * The source is drained by an internal background task immediately on creation,
 * so `final` resolves regardless of whether `textDeltas` is consumed:
 *
 *   // Only final:
 *   const text = await stream.final;
 *
 *   // Only deltas:
 *   for await (const d of stream.textDeltas) { ... }
 *
 *   // Both (concurrent):
 *   for await (const d of stream.textDeltas) { ... }
 *   const text = await stream.final; // already resolved by the time the loop exits
 *
 * `textDeltas` yields each delta as it arrives from the internal queue.
 * If the caller does not iterate `textDeltas`, the queue grows but is bounded
 * by the source length — acceptable for the typical chat-response size.
 */
export function createMessageStream(
  source: AsyncIterable<string>,
  telemetry?: StreamTelemetry,
): MessageStream {
  // The drain task starts below, on creation — so this is the moment the stream
  // opens, and the right one to timestamp TTFT from.
  const startedAt = Date.now();
  let firstTokenSeen = false;
  if (telemetry) {
    trackEvent("stream_started", {
      route: telemetry.route,
      request_id: telemetry.request_id,
      conversation_id: telemetry.conversation_id,
    });
  }

  // ── Internal queue shared between drain task and textDeltas consumer ─────────
  const queue: string[] = [];
  let doneSignal = false;
  let drainError: unknown = null;

  // Notify textDeltas consumer when new items arrive or drain completes.
  // Using a simple resolve-and-replace pattern avoids a full EventEmitter.
  let notifyConsumer: (() => void) | null = null;
  function notify(): void {
    const fn = notifyConsumer;
    notifyConsumer = null;
    fn?.();
  }

  let resolveFinale!: (text: string) => void;
  let rejectFinale!: (err: unknown) => void;
  const final = new Promise<string>((res, rej) => {
    resolveFinale = res;
    rejectFinale = rej;
  });
  // Suppress unhandledRejection when the caller only consumes textDeltas and
  // never attaches a .catch() / try-catch to `final`. The rejection is still
  // surfaced to any caller that does await `final` — this no-op handler only
  // prevents the runtime from treating it as unhandled.
  void final.catch(() => {});

  // ── Drain task — runs immediately, independent of any consumer ───────────────
  const accumulated: string[] = [];
  // Intentionally not awaited — runs as a background microtask chain.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  (async () => {
    try {
      for await (const delta of source) {
        if (telemetry && !firstTokenSeen) {
          firstTokenSeen = true;
          // The perceived-latency milestone, and the source of the TTFT p95 SLO.
          // Measured from stream creation rather than from the first read of
          // `textDeltas`, because the drain runs whether or not a caller iterates
          // — keying off the consumer would make TTFT a function of UI code.
          trackEvent("message_first_token", {
            route: telemetry.route,
            request_id: telemetry.request_id,
            ttft_ms: Date.now() - startedAt,
          });
        }
        accumulated.push(delta);
        queue.push(delta);
        notify();
      }
      doneSignal = true;
      notify();
      if (telemetry) {
        trackEvent("message_completed", {
          route: telemetry.route,
          request_id: telemetry.request_id,
          duration_ms: Date.now() - startedAt,
          outcome: "success",
        });
      }
      resolveFinale(accumulated.join(""));
    } catch (err) {
      drainError = err;
      doneSignal = true;
      notify();
      if (telemetry) {
        // Both, and they are not redundant: `stream_dropped` is transport health
        // (the mid-stream-drop SLO), while `message_completed` is the turn funnel.
        // Emitting only the drop would leave the funnel with no denominator for
        // failed turns, so its success rate would read 100% while streams broke.
        trackEvent("stream_dropped", { route: telemetry.route, reason: dropReason(err) });
        trackEvent("message_completed", {
          route: telemetry.route,
          request_id: telemetry.request_id,
          duration_ms: Date.now() - startedAt,
          outcome: "error",
        });
      }
      rejectFinale(err);
    }
  })();

  // ── textDeltas generator — yields from the shared queue ──────────────────────
  async function* textDeltas(): AsyncIterable<string> {
    let index = 0;
    while (true) {
      // Drain everything currently in the queue
      while (index < queue.length) {
        yield queue[index++];
      }
      // If drain is complete, check for error then stop
      if (doneSignal) {
        // Re-throw the original error captured from the source stream (line ~109).
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (drainError !== null) throw drainError;
        break;
      }
      // Wait for the drain task to push more items or signal done
      await new Promise<void>(resolve => {
        notifyConsumer = resolve;
      });
    }
  }

  return {
    textDeltas: textDeltas(),
    final,
  };
}
