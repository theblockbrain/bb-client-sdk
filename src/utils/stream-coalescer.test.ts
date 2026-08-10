import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamCoalescer } from "./stream-coalescer.js";

/** The timer fallback period, mirrored so the assertions read as intent. */
const FRAME_MS = 16;

describe("createStreamCoalescer, with an explicit interval", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("delivers only the newest value, once per interval", () => {
    const onFlush = vi.fn();
    const coalescer = createStreamCoalescer<string>({ onFlush, intervalMs: 60 });

    coalescer.push("H");
    coalescer.push("He");
    coalescer.push("Hel");
    vi.advanceTimersByTime(60);

    expect(onFlush).toHaveBeenCalledExactlyOnceWith("Hel");
  });

  it("delivers nothing before the interval has elapsed", () => {
    const onFlush = vi.fn();
    const coalescer = createStreamCoalescer<string>({ onFlush, intervalMs: 60 });

    coalescer.push("H");
    vi.advanceTimersByTime(59);

    expect(onFlush).not.toHaveBeenCalled();
  });

  // The schedule stands while one is due, but it must re-arm afterwards. A
  // coalescer that only ever delivered once would look correct for a short
  // stream and freeze on a long one.
  it("re-arms after a delivery", () => {
    const onFlush = vi.fn();
    const coalescer = createStreamCoalescer<string>({ onFlush, intervalMs: 60 });

    coalescer.push("one");
    vi.advanceTimersByTime(60);
    coalescer.push("two");
    vi.advanceTimersByTime(60);

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith("two");
  });

  // Both halves of `flush`. Without the delivery the final token is stranded and
  // the output ends one delta short; without the cancel, the scheduled callback
  // fires after the turn settled and re-writes what the caller replaced.
  it("flush delivers the pending value and cancels the schedule", () => {
    const onFlush = vi.fn();
    const coalescer = createStreamCoalescer<string>({ onFlush, intervalMs: 60 });

    coalescer.push("last token");
    coalescer.flush();
    expect(onFlush).toHaveBeenCalledExactlyOnceWith("last token");

    vi.advanceTimersByTime(60);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("flush is a no-op when nothing is pending", () => {
    const onFlush = vi.fn();
    const coalescer = createStreamCoalescer<string>({ onFlush, intervalMs: 60 });

    coalescer.flush();
    expect(onFlush).not.toHaveBeenCalled();

    // And it does not re-deliver a value that has already gone out.
    coalescer.push("a");
    coalescer.flush();
    coalescer.flush();
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("cancel discards the pending value rather than delivering it", () => {
    const onFlush = vi.fn();
    const coalescer = createStreamCoalescer<string>({ onFlush, intervalMs: 60 });

    coalescer.push("abandoned");
    coalescer.cancel();
    vi.advanceTimersByTime(60);

    expect(onFlush).not.toHaveBeenCalled();
  });

  it("keeps working after a cancel", () => {
    const onFlush = vi.fn();
    const coalescer = createStreamCoalescer<string>({ onFlush, intervalMs: 60 });

    coalescer.push("abandoned");
    coalescer.cancel();
    coalescer.push("kept");
    vi.advanceTimersByTime(60);

    expect(onFlush).toHaveBeenCalledExactlyOnceWith("kept");
  });

  // `hasPending` is a separate flag rather than a null sentinel precisely so a
  // pushed `undefined` is a value, not an empty buffer.
  it("treats a nullish value as a real value", () => {
    const onFlush = vi.fn();
    const coalescer = createStreamCoalescer<string | undefined>({ onFlush, intervalMs: 60 });

    coalescer.push(undefined);
    vi.advanceTimersByTime(60);

    expect(onFlush).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  // The rule that keeps `useChatStream` behaving as it always has, and that
  // makes a requested rate mean the same thing on every platform: a frame
  // callback fires roughly four times as often as a 60ms interval.
  it("never uses requestAnimationFrame when an interval was given", () => {
    const raf = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const onFlush = vi.fn();
    const coalescer = createStreamCoalescer<string>({ onFlush, intervalMs: 60 });

    coalescer.push("a");

    expect(raf).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(onFlush).toHaveBeenCalledExactlyOnceWith("a");
  });
});

describe("createStreamCoalescer, following the display", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("schedules on a frame when one is available", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const onFlush = vi.fn();
    const coalescer = createStreamCoalescer<string>({ onFlush });

    coalescer.push("H");
    coalescer.push("Hi");
    expect(frames).toHaveLength(1);
    expect(onFlush).not.toHaveBeenCalled();

    frames[0](0);
    expect(onFlush).toHaveBeenCalledExactlyOnceWith("Hi");
  });

  it("cancels the frame on cancel", () => {
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", () => 7);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const coalescer = createStreamCoalescer<string>({ onFlush: vi.fn() });

    coalescer.push("H");
    coalescer.cancel();

    expect(cancel).toHaveBeenCalledExactlyOnceWith(7);
  });

  // React Native and Node have timers and no frames. The behaviour degrades to
  // "roughly a frame" rather than breaking, which is why the fallback exists at
  // all rather than the coalescer requiring a DOM.
  it("falls back to a timer where there is no requestAnimationFrame", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);
    const onFlush = vi.fn();
    const coalescer = createStreamCoalescer<string>({ onFlush });

    coalescer.push("Hi");
    vi.advanceTimersByTime(FRAME_MS);

    expect(onFlush).toHaveBeenCalledExactlyOnceWith("Hi");
  });

  // Scheduling a frame that cannot be cancelled would let a stale callback fire
  // after `cancel()` and paint over a value the caller had already replaced. A
  // timer is always cancellable, so the pair is required, not just the request.
  it("falls back to a timer when frames cannot be cancelled", () => {
    vi.useFakeTimers();
    const raf = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", undefined);
    const onFlush = vi.fn();
    const coalescer = createStreamCoalescer<string>({ onFlush });

    coalescer.push("Hi");

    expect(raf).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FRAME_MS);
    expect(onFlush).toHaveBeenCalledExactlyOnceWith("Hi");
  });
});
