import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/index.js";
import { type AgentsResponse, BBApiError } from "../api/index.js";
import { bbKeys } from "./keys.js";
import { useDeleteConversation, useSetAgentActive } from "./mutations.js";
import { makeWrapper } from "./test-harness.js";

vi.mock("../api/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../api/index.js")>();
  return {
    ...actual,
    setAgentActive: vi.fn(),
    deleteConversation: vi.fn(),
    invalidateConvoDetailCache: vi.fn(),
  };
});

describe("useSetAgentActive", () => {
  beforeEach(() => vi.clearAllMocks());

  it("optimistically flips active, then rolls back when the request fails", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const key = bbKeys("org-1").agents.list;
    client.setQueryData<AgentsResponse>(key, {
      a1: { id: "a1", name: "A", active: false, available: true },
    });

    // Hold the request in-flight so the optimistic state is observable, then reject.
    let rejectRequest!: (err: unknown) => void;
    vi.mocked(api.setAgentActive).mockReturnValue(
      new Promise<never>((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );

    const { result } = renderHook(() => useSetAgentActive(), { wrapper: makeWrapper(client) });

    act(() => {
      result.current.mutate({ agentId: "a1", active: true });
    });

    // onMutate writes the optimistic value while the request is pending…
    await waitFor(() => expect(client.getQueryData<AgentsResponse>(key)!.a1.active).toBe(true));

    // …and onError rolls it back once the request rejects.
    act(() => {
      rejectRequest(new BBApiError("boom", 500));
    });
    await waitFor(() => expect(client.getQueryData<AgentsResponse>(key)!.a1.active).toBe(false));
  });
});

describe("useDeleteConversation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("purges the SDK's hidden routing cache (convoDetailCache) on delete", async () => {
    vi.mocked(api.deleteConversation).mockResolvedValue(undefined);

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: makeWrapper() });
    await act(async () => {
      await result.current.mutateAsync("c1");
    });

    expect(api.deleteConversation).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1" }),
      "c1",
    );
    expect(api.invalidateConvoDetailCache).toHaveBeenCalledWith("c1");
  });
});
