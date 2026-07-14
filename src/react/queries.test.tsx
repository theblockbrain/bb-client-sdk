import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/index.js";
import { useBots } from "./queries.js";
import { makeWrapper } from "./test-harness.js";

vi.mock("../api/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../api/index.js")>();
  return { ...actual, fetchBotList: vi.fn() };
});

describe("useBots", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches the bot list through the injected auth context", async () => {
    const bots = [{ id: "b1", name: "Bot One", model: "gpt-4o" }];
    vi.mocked(api.fetchBotList).mockResolvedValue(bots);

    const { result } = renderHook(() => useBots(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(bots);
    expect(api.fetchBotList).toHaveBeenCalledTimes(1);
    // Called with the AuthContext supplied by the provider (freshest, via ref).
    expect(api.fetchBotList).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", token: "test-token" }),
    );
  });
});
