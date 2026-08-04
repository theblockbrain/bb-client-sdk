import { describe, expect, it } from "vitest";
import { BB_CACHE_DEFAULT, BB_CACHE_POLICY, cachePolicyFor } from "./cache-policy.js";

/**
 * L13 · the policy is the SDK's answer to "how long may this be served from
 * cache", readable by any cache — not a react-query literal.
 */
describe("BB_CACHE_POLICY", () => {
  it("keeps messages non-stale — a conversation is live", () => {
    // The one override that already existed, and the reason a single global TTL
    // was the wrong shape.
    expect(cachePolicyFor("messages").staleMs).toBe(0);
  });

  it("caches admin-driven resources far longer than user-driven ones", () => {
    // tenantConfig/capabilities change on an admin action, not a navigation.
    expect(cachePolicyFor("tenantConfig").staleMs).toBeGreaterThan(cachePolicyFor("bots").staleMs);
    expect(cachePolicyFor("capabilities").staleMs).toBeGreaterThan(
      cachePolicyFor("conversations").staleMs,
    );
  });

  it("preserves the previous 5-minute default for unremarkable resources", () => {
    // This refactor must not change behaviour for anything that had no override.
    expect(BB_CACHE_DEFAULT.staleMs).toBe(5 * 60_000);
    expect(BB_CACHE_DEFAULT.retainMs).toBe(10 * 60_000);
    for (const r of ["bots", "botDetail", "conversations", "conversationDetail"] as const) {
      expect(cachePolicyFor(r)).toEqual(BB_CACHE_DEFAULT);
    }
  });

  it("never retains for less time than it serves stale", () => {
    // Evicting before a value goes stale would make the staleness bound a lie.
    for (const [resource, entry] of Object.entries(BB_CACHE_POLICY)) {
      expect(entry.retainMs, resource).toBeGreaterThanOrEqual(entry.staleMs);
    }
  });
});
