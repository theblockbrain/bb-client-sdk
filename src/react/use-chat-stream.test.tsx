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
