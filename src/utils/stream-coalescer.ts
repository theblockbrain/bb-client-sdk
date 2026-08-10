/**
 * Coalesce a fast stream of values into at most one delivery per interval.
 *
 * A token stream arrives faster than anything should react to it. Every surface
 * that renders one arrived at the same shape independently — hold the newest
 * value, schedule one delivery, drop the ones in between — and there were three
 * copies of it before this: `useChatStream` in this SDK (timer, 60ms),
 * `ms-word-addin`'s agent turn (rAF, 16ms fallback) and that add-in's older
 * Blocky path (a third). The Word copy carries a fix the others do not: a
 * trailing {@link StreamCoalescer.flush} at the end of a turn, without which the
 * final token stays in the buffer and the message ends one delta short of the
 * answer.
 *
 * Why it matters is not the cost of the delivery itself. In Word's case
 * (PDEV-5181) each one mutated a store whose reference change re-rendered the
 * whole timeline; in React it is a `setState` per token. Either way the work is
 * proportional to tokens rather than to frames.
 *
 * Framework-agnostic and DOM-optional on purpose: no React, and no assumption
 * that `requestAnimationFrame` exists (React Native and Node have timers only).
 */

/** Timer fallback period when there is no `requestAnimationFrame`: one frame at 60Hz. */
const FRAME_MS = 16;

export interface StreamCoalescerConfig<T> {
  /**
   * Delivers the newest value pushed since the last flush. Never called with a
   * value that has already been delivered, and never called at all if nothing
   * was pushed.
   */
  onFlush: (value: T) => void;
  /**
   * Minimum gap between deliveries, in milliseconds.
   *
   * **Omit it to follow the display.** With no interval the scheduler uses
   * `requestAnimationFrame`, which is the right rate for anything that paints:
   * it matches the refresh rate, and it stops entirely in a background tab.
   * Where `requestAnimationFrame` is absent (React Native, Node, a worker) it
   * falls back to a timer at {@link FRAME_MS}, so the behaviour degrades to
   * "roughly a frame" rather than breaking.
   *
   * **Pass one to cap the rate yourself.** An explicit interval always uses a
   * timer and never `requestAnimationFrame`, because a frame callback cannot
   * express "at most every 60ms" — it would fire about four times as often. A
   * caller that asks for a rate gets that rate on every platform.
   */
  intervalMs?: number;
}

export interface StreamCoalescer<T> {
  /** Record the newest value and schedule a delivery if one is not already due. */
  push(value: T): void;
  /**
   * Cancel the pending delivery, then deliver what it was holding. No-op when
   * nothing is pending.
   *
   * Both halves matter at the end of a stream. Without the delivery the last
   * value is stranded and the output ends one token short. Without the cancel,
   * the scheduled callback fires *after* the stream has settled and re-writes a
   * value the caller has already replaced with the final one.
   */
  flush(): void;
  /**
   * Cancel the pending delivery and discard what it was holding.
   *
   * For abandoning a stream, not ending one: on unmount, on abort, or once the
   * caller has committed a final value that a late partial would overwrite.
   */
  cancel(): void;
}

/**
 * Build a coalescer. See {@link StreamCoalescerConfig.intervalMs} for the
 * scheduling rule.
 *
 * ```ts
 * const coalescer = createStreamCoalescer<string>({ onFlush: setText });
 * for await (const delta of stream.textDeltas) coalescer.push((buffer += delta));
 * coalescer.flush();
 * ```
 */
export function createStreamCoalescer<T>(config: StreamCoalescerConfig<T>): StreamCoalescer<T> {
  const { onFlush, intervalMs } = config;

  let pending: T;
  // Separate from `pending` rather than using a null sentinel, so `T` may itself
  // include `null` or `undefined` without a pushed value looking like an empty
  // buffer.
  let hasPending = false;
  let frameId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  /**
   * Whether to follow the display. Both halves are required: scheduling a frame
   * that cannot be cancelled would let a stale callback fire after `cancel()`.
   *
   * Resolved on each schedule rather than once at module scope, so importing
   * this module stays safe in a runtime with no DOM.
   */
  const followsDisplay = (): boolean =>
    intervalMs === undefined &&
    typeof requestAnimationFrame === "function" &&
    typeof cancelAnimationFrame === "function";

  const deliver = (): void => {
    frameId = null;
    timerId = null;
    if (!hasPending) return;
    hasPending = false;
    onFlush(pending);
  };

  const clearScheduled = (): void => {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  return {
    push(value: T): void {
      pending = value;
      hasPending = true;
      // Already due: the newest value replaces the one that was queued, and the
      // schedule stands. Re-arming it here is what would turn a fast stream into
      // a delivery that never happens.
      if (frameId !== null || timerId !== null) return;
      if (followsDisplay()) {
        frameId = requestAnimationFrame(deliver);
        return;
      }
      timerId = setTimeout(deliver, intervalMs ?? FRAME_MS);
    },

    flush(): void {
      clearScheduled();
      deliver();
    },

    cancel(): void {
      clearScheduled();
      hasPending = false;
    },
  };
}
