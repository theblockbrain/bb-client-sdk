import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/index.js";
import type { AuthContext } from "../settings/auth-mode.js";
import { BB_CACHE_DEFAULT, cachePolicyFor } from "../settings/cache-policy.js";
import {
  botsQueryOptions,
  capabilitiesQueryOptions,
  messagesInfiniteOptions,
  tenantConfigQueryOptions,
  useBots,
} from "./queries.js";
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

/**
 * L13 · the policy has to REACH react-query, not merely exist.
 *
 * The defect these pin: `BB_CACHE_POLICY` declared 30 minutes for `tenantConfig` and
 * `capabilities` while nothing read it, so those hooks silently kept the 5-minute client
 * default and went on refetching per navigation. A policy no consumer reads is
 * documentation, not policy — and the unit test on the table alone could not see it.
 */
describe("cache policy reaches react-query (PDEV-7767)", () => {
  const getCtx = (): AuthContext => ({
    baseUrl: "https://example.invalid",
    token: "t",
    orgId: "o",
    mode: "oauth",
  });

  it("puts each resource's own policy on its options, not the client default", () => {
    const cases = [
      [tenantConfigQueryOptions(getCtx, "o"), "tenantConfig"],
      [capabilitiesQueryOptions(getCtx, "o"), "capabilities"],
      [botsQueryOptions(getCtx, "o"), "bots"],
      [messagesInfiniteOptions(getCtx, "o", "c1"), "messages"],
    ] as const;

    for (const [options, resource] of cases) {
      const policy = cachePolicyFor(resource);
      expect(options, resource).toMatchObject({
        staleTime: policy.staleMs,
        gcTime: policy.retainMs,
      });
    }
  });

  it("actually gives the admin-driven resources their longer window", () => {
    // The behaviour the CHANGELOG promises. Asserted against the default rather than a
    // literal, so it stays true if the default moves.
    for (const options of [
      tenantConfigQueryOptions(getCtx, "o"),
      capabilitiesQueryOptions(getCtx, "o"),
    ]) {
      expect(options.staleTime).toBe(30 * 60_000);
      expect(options.staleTime).toBeGreaterThan(BB_CACHE_DEFAULT.staleMs);
    }
  });
});
