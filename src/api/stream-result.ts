/**
 * Shared streaming result shape used by both the Blocky and Agentic send paths.
 *
 * `sendMessage` with `enableStreaming: true` resolves to this type regardless
 * of which backend handled the request — callers get a unified interface.
 */

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
export function wrapStringAsStream(text: string): MessageStream {
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
): MessageStream {
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
        accumulated.push(delta);
        queue.push(delta);
        notify();
      }
      doneSignal = true;
      notify();
      resolveFinale(accumulated.join(""));
    } catch (err) {
      drainError = err;
      doneSignal = true;
      notify();
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
        if (drainError !== null) throw drainError;
        break;
      }
      // Wait for the drain task to push more items or signal done
      await new Promise<void>((resolve) => {
        notifyConsumer = resolve;
      });
    }
  }

  return {
    textDeltas: textDeltas(),
    final,
  };
}
