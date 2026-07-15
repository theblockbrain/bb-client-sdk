import { type InfiniteData, QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageListBody, MessageStream } from "../api/index.js";
import * as api from "../api/index.js";
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
});
