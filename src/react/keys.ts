/**
 * Query-key factory for the `./react` layer.
 *
 * Every key is rooted at `['bb', orgId]`, so the React Query cache is partitioned
 * by tenant — cross-tenant admin views can never collide, and you cannot build a
 * sub-key without going through `bbKeys(orgId)`.
 *
 * A coarse key prefix-matches every finer key beneath it, so
 * `invalidateQueries({ queryKey: bbKeys(org).messages.forConvo(id) })` clears
 * every paginated/keyword-filtered variant for that conversation at once.
 *
 * This module is framework-neutral (no React, no @tanstack import) so it can be
 * reused by a future Lit/Vue binding over the same `@tanstack/query-core`.
 */
export function bbKeys(orgId: string) {
  const root = ["bb", orgId] as const;
  return {
    root,
    bots: {
      all: [...root, "bots"] as const,
      list: [...root, "bots", "list"] as const,
      detail: (botId: string) => [...root, "bots", "detail", botId] as const,
    },
    conversations: {
      all: [...root, "conversations"] as const,
      detail: (convoId: string) => [...root, "conversations", "detail", convoId] as const,
      attachments: (convoId: string) =>
        [...root, "conversations", "detail", convoId, "attachments"] as const,
      websearch: (convoId: string) =>
        [...root, "conversations", "detail", convoId, "websearch"] as const,
    },
    messages: {
      /** Prefix over every page-set of a conversation, any keyword filter. */
      forConvo: (convoId: string) => [...root, "messages", convoId] as const,
      /** A specific paginated set (the infinite query). Live chat uses keyword "". */
      list: (convoId: string, filters: { keyword?: string } = {}) =>
        [...root, "messages", convoId, { keyword: filters.keyword ?? "" }] as const,
    },
    agents: {
      all: [...root, "agents"] as const,
      list: [...root, "agents", "list"] as const,
    },
    capabilities: {
      all: [...root, "capabilities"] as const,
      list: [...root, "capabilities", "list"] as const,
    },
    tenant: {
      all: [...root, "tenant"] as const,
      config: [...root, "tenant", "config"] as const,
      list: (filters: { name?: string; page?: number; size?: number } = {}) =>
        [...root, "tenant", "list", filters] as const,
      detail: (tenantId: string) => [...root, "tenant", "detail", tenantId] as const,
    },
    notes: {
      all: [...root, "notes"] as const,
    },
    websearch: {
      providers: [...root, "websearch", "providers"] as const,
    },
  } as const;
}

export type BBKeys = ReturnType<typeof bbKeys>;
