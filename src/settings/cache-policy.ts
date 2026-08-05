/**
 * Cache policy (L13).
 *
 * Framework-agnostic on purpose. The TTLs used to live as literals inside
 * `react/provider.tsx`, which meant they were React-only and unreadable: a Lit
 * surface or the Slack backend could not honour the same freshness rules even if it
 * wanted to, and "how long is a bot list good for" was a react-query
 * implementation detail rather than a decision the SDK had made.
 *
 * Milliseconds, per resource. Values are the SDK's answer to "how long may this be
 * served from cache", independent of which cache honours it.
 */

/**
 * Resources the SDK caches.
 *
 * These are **flat policy names, not `bbKeys` segments** — the two vocabularies differ on
 * purpose and it is worth not confusing them. `bbKeys` is hierarchical and per-tenant
 * (`bots.detail(id)`, `tenant.config`, `websearch.providers`); a policy is one decision per
 * resource, so `botDetail`, `tenantConfig` and `webSearch` are single names with no tenant
 * in them. A policy keyed by cache key would need one entry per bot id.
 */
export type BBCachedResource =
  | "bots"
  | "botDetail"
  | "conversations"
  | "conversationDetail"
  | "messages"
  | "agents"
  | "capabilities"
  | "tenantConfig"
  | "webSearch";

export interface BBCacheEntry {
  /** How long a value may be served without refetching. */
  readonly staleMs: number;
  /** How long an unused value is retained before eviction. */
  readonly retainMs: number;
}

const FIVE_MIN = 5 * 60_000;
const TEN_MIN = 10 * 60_000;
const THIRTY_MIN = 30 * 60_000;

/**
 * The default policy.
 *
 * Not one global number, which is what it was. The interesting cases are the ones
 * that differ:
 *
 * - `messages` is `staleMs: 0` — a conversation is live, so the server is the
 *   source of truth every time it is opened. This was the single per-resource
 *   override that already existed, and it is the reason a global TTL was wrong.
 * - `tenantConfig` and `capabilities` are half an hour: they change on an admin
 *   action, not on a user action, so refetching them per navigation is waste.
 * - Everything else keeps the previous 5-minute default, so this refactor is not a
 *   behaviour change for any resource that had no override.
 */
export const BB_CACHE_POLICY: Readonly<Record<BBCachedResource, BBCacheEntry>> = {
  bots: { staleMs: FIVE_MIN, retainMs: TEN_MIN },
  botDetail: { staleMs: FIVE_MIN, retainMs: TEN_MIN },
  conversations: { staleMs: FIVE_MIN, retainMs: TEN_MIN },
  conversationDetail: { staleMs: FIVE_MIN, retainMs: TEN_MIN },
  // Live: never served stale.
  messages: { staleMs: 0, retainMs: TEN_MIN },
  agents: { staleMs: FIVE_MIN, retainMs: TEN_MIN },
  // Admin-driven, not user-driven.
  capabilities: { staleMs: THIRTY_MIN, retainMs: THIRTY_MIN },
  tenantConfig: { staleMs: THIRTY_MIN, retainMs: THIRTY_MIN },
  webSearch: { staleMs: FIVE_MIN, retainMs: TEN_MIN },
};

/** Defaults for a cache with no per-resource entry — the previous global values. */
export const BB_CACHE_DEFAULT: BBCacheEntry = { staleMs: FIVE_MIN, retainMs: TEN_MIN };

/** The policy for a resource, falling back to {@link BB_CACHE_DEFAULT}. */
export function cachePolicyFor(resource: BBCachedResource): BBCacheEntry {
  return BB_CACHE_POLICY[resource] ?? BB_CACHE_DEFAULT;
}
