import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageListBody, MessageStream } from "../api/index.js";
import * as api from "../api/index.js";
import { AgenticStreamError } from "../api/index.js";
import { bbKeys } from "./keys.js";
import { makeWrapper } from "./test-harness.js";
import { useChatStream } from "./use-chat-stream.js";

vi.mock("../api/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../api/index.js")>();
  return { ...actual, sendMessage: vi.fn() };
});

describe("useChatStream", () => {
  beforeEach(() => vi.clearAllMocks());

  it("streams deltas and commits the final assistant message into the messages cache", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const liveKey = bbKeys("org-1").messages.list("c1");
    client.setQueryData<InfiniteData<MessageListBody, number>>(liveKey, {
      pages: [{ data: [], total: 0 }],
      pageParams: [1],
    });

    const stream: MessageStream = {
      textDeltas: (async function* () {
        yield "He";
        yield "llo";
      })(),
      final: Promise.resolve("Hello"),
    };
    vi.mocked(api.sendMessage).mockResolvedValue(stream);

    const { result } = renderHook(() => useChatStream({ convoId: "c1" }), {
      wrapper: makeWrapper(client),
    });

    await act(async () => {
      await result.current.send("hi");
    });

    await waitFor(() => {
      const data = client.getQueryData<InfiniteData<MessageListBody, number>>(liveKey)!;
      const msgs = data.pages[0].data;
      expect(msgs.some(m => m.role === "assistant" && m.content === "Hello")).toBe(true);
      expect(msgs.some(m => m.role === "user" && m.content === "hi")).toBe(true);
    });
    // sendMessage was invoked in streaming mode with the injected AuthContext
    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      "c1",
      "hi",
      expect.objectContaining({ enableStreaming: true }),
    );
  });

  // The hook holds live tokens in `streamingText` and hands ownership to the
  // message cache on `final`. That handover is what breaks if the coalescer is
  // wired up wrongly: a stream whose deltas never reach state renders an empty
  // bubble until the turn ends, and one that is never cancelled paints a stale
  // partial over the committed answer.
  //
  // The coalescing itself — one delivery per interval, newest value wins — is
  // pinned in `utils/stream-coalescer.test.ts`, where it can be asserted exactly
  // rather than inferred through React's scheduling.
  it("renders live tokens while streaming, and clears them once the answer commits", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const liveKey = bbKeys("org-1").messages.list("c1");
    client.setQueryData<InfiniteData<MessageListBody, number>>(liveKey, {
      pages: [{ data: [], total: 0 }],
      pageParams: [1],
    });

    // Held open so the in-flight state is observable at all: an unblocked
    // generator runs to completion inside the same `act` and there is no moment
    // where `streamingText` is non-empty.
    let releaseStream = (): void => {};
    const streamHeld = new Promise<void>(resolve => {
      releaseStream = resolve;
    });

    const stream: MessageStream = {
      textDeltas: (async function* () {
        yield "He";
        yield "llo";
        await streamHeld;
      })(),
      final: Promise.resolve("Hello"),
    };
    vi.mocked(api.sendMessage).mockResolvedValue(stream);

    const { result } = renderHook(
      // 1ms so the flush lands promptly under real timers. The interval is a
      // rate cap, and this test is about delivery, not about the cap.
      () => useChatStream({ convoId: "c1", flushIntervalMs: 1 }),
      { wrapper: makeWrapper(client) },
    );

    let sent: Promise<void> = Promise.resolve();
    await act(async () => {
      sent = result.current.send("hi");
      // Let the generator reach the gate so both deltas have been pushed.
      await Promise.resolve();
    });

    // Accumulated, not just the newest delta: the hook pushes the whole buffer.
    await waitFor(() => expect(result.current.streamingText).toBe("Hello"));
    expect(result.current.isStreaming).toBe(true);

    await act(async () => {
      releaseStream();
      await sent;
    });

    expect(result.current.streamingText).toBe("");
    expect(result.current.isStreaming).toBe(false);
    const msgs =
      client.getQueryData<InfiniteData<MessageListBody, number>>(liveKey)?.pages[0].data ?? [];
    expect(msgs.some(m => m.role === "assistant" && m.content === "Hello")).toBe(true);
  });

  // `reset()` is the one path that clears the buffer *without* ending the turn,
  // so it is the one path that has to cancel the coalescer by hand. The old timer
  // read `bufferRef.current` at fire time, which made clearing the buffer enough;
  // the coalescer captures its value at push time, so a delivery armed before the
  // reset still carries the pre-reset partial. Without the cancel the composer
  // clears and then, up to `flushIntervalMs` later, repaints the stale text.
  it("stays cleared when reset() lands while a delivery is already armed", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const liveKey = bbKeys("org-1").messages.list("c1");
    client.setQueryData<InfiniteData<MessageListBody, number>>(liveKey, {
      pages: [{ data: [], total: 0 }],
      pageParams: [1],
    });

    // Resolves once the loop body has run for the first delta, so the test acts
    // on "a delivery is armed" rather than on a guessed number of microtasks.
    let deltaPushed = (): void => {};
    const pushed = new Promise<void>(resolve => {
      deltaPushed = resolve;
    });
    let releaseStream = (): void => {};
    const streamHeld = new Promise<void>(resolve => {
      releaseStream = resolve;
    });

    const stream: MessageStream = {
      textDeltas: (async function* () {
        yield "Hello";
        // Reached only after the consumer pushed the delta and asked for the next.
        deltaPushed();
        await streamHeld;
      })(),
      final: Promise.resolve("Hello"),
    };
    vi.mocked(api.sendMessage).mockResolvedValue(stream);

    const { result } = renderHook(
      // Long enough that reset() reliably lands inside the armed window under
      // real timers, short enough that waiting it out does not slow the suite.
      () => useChatStream({ convoId: "c1", flushIntervalMs: 50 }),
      { wrapper: makeWrapper(client) },
    );

    let sent: Promise<void> = Promise.resolve();
    await act(async () => {
      sent = result.current.send("hi");
      await pushed;
    });

    // The delivery is armed but has not fired, so nothing has reached state yet.
    expect(result.current.streamingText).toBe("");

    act(() => result.current.reset());

    // Past the armed delivery.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
    });
    const afterArmedDelivery = result.current.streamingText;

    // Let the turn unwind before asserting, so a failure does not strand the
    // generator on its gate.
    await act(async () => {
      releaseStream();
      await sent;
    });

    expect(afterArmedDelivery).toBe("");
  });

  it("does not commit a truncated agentic run as the final assistant message", async () => {
    // PDEV-7333. The defect this locks down: `callAgenticStream` used to `break`
    // when the resume budget ran out, so a turn that stopped mid-work resolved
    // `final` with whatever text had accumulated. The hook could not tell that
    // apart from a completed answer and wrote it into the message cache as the
    // assistant's reply — the user saw a confident half-answer with no
    // indication anything had gone wrong. Terminating with a thrown
    // AgenticStreamError is what makes the two distinguishable.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const liveKey = bbKeys("org-1").messages.list("c1");
    client.setQueryData<InfiniteData<MessageListBody, number>>(liveKey, {
      pages: [{ data: [], total: 0 }],
      pageParams: [1],
    });

    const truncation = new AgenticStreamError("budget gone", "resume-budget-exhausted", {
      partial: true,
    });
    const rejected = Promise.reject(truncation);
    // The real createMessageStream attaches this same no-op so a caller that
    // only iterates textDeltas does not trip an unhandled rejection.
    void rejected.catch(() => {});

    const stream: MessageStream = {
      textDeltas: (async function* () {
        yield "Half an ans";
        throw truncation;
      })(),
      final: rejected,
    };
    vi.mocked(api.sendMessage).mockResolvedValue(stream);

    const { result } = renderHook(() => useChatStream({ convoId: "c1" }), {
      wrapper: makeWrapper(client),
    });

    await act(async () => {
      await result.current.send("hi");
    });

    await waitFor(() => {
      expect(result.current.error).toBeInstanceOf(AgenticStreamError);
    });
    expect((result.current.error as AgenticStreamError).reason).toBe("resume-budget-exhausted");

    // Nothing partial was committed, and the optimistic user message rolled back.
    const msgs =
      client.getQueryData<InfiniteData<MessageListBody, number>>(liveKey)?.pages[0].data ?? [];
    expect(msgs.some(m => m.role === "assistant")).toBe(false);
    expect(msgs.some(m => m.content === "Half an ans")).toBe(false);
    expect(msgs).toHaveLength(0);
    expect(result.current.isStreaming).toBe(false);
  });
});
