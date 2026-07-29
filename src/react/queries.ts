import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import {
  type AdminListingOptions,
  fetchAgents,
  fetchBotDetail,
  fetchBotList,
  fetchCapabilities,
  getAvailableWebSearchProviders,
  getConversationAttachments,
  getConversationDetail,
  getConversationWebSearch,
  getMessageList,
  getTenantConfig,
  type MessageListBody,
} from "../api/index.js";
import type { AuthContext } from "../settings/auth-mode.js";
import { bbKeys } from "./keys.js";
import { useBBContext } from "./provider.js";

/**
 * Every read endpoint maps to a thin `useQuery`. Each hook exposes a
 * `queryOptions` factory (reusable in SSR loaders / prefetch) plus a `use…()`
 * hook that reads the AuthContext from <BBClientProvider>. Factories take
 * `getCtx` (not a token) so the freshest token is used at fetch time.
 */

// ── bots ────────────────────────────────────────────────────────────────────────
export function botsQueryOptions(getCtx: () => AuthContext, orgId: string) {
  return queryOptions({
    queryKey: bbKeys(orgId).bots.list,
    queryFn: () => fetchBotList(getCtx()),
  });
}
export function useBots() {
  const { getAuthContext, orgId } = useBBContext();
  return useQuery(botsQueryOptions(getAuthContext, orgId));
}

export function botDetailQueryOptions(getCtx: () => AuthContext, orgId: string, botId: string) {
  return queryOptions({
    queryKey: bbKeys(orgId).bots.detail(botId),
    queryFn: () => fetchBotDetail(getCtx(), botId),
    enabled: !!botId,
  });
}
export function useBotDetail(botId: string) {
  const { getAuthContext, orgId } = useBBContext();
  return useQuery(botDetailQueryOptions(getAuthContext, orgId, botId));
}

/**
 * Cache-key suffix for an admin listing.
 *
 * An admin listing returns a strictly larger set than a normal one, so the two must
 * not share a cache entry — otherwise a normal user can read admin-populated data,
 * or an admin's view gets overwritten by a filtered one. Only appended when a flag is
 * actually set, so the default key shape is unchanged; prefix-based invalidation on
 * the base key still reaches both entries.
 */
function listingKeySuffix(options?: AdminListingOptions): readonly AdminListingOptions[] {
  const includeInactive = options?.includeInactive === true;
  const includeUnavailable = options?.includeUnavailable === true;
  return includeInactive || includeUnavailable ? [{ includeInactive, includeUnavailable }] : [];
}

// ── agents (cross-tenant aware) ───────────────────────────────────────────────────
export function agentsQueryOptions(
  getCtx: () => AuthContext,
  homeOrgId: string,
  targetOrgId?: string,
  options?: AdminListingOptions,
) {
  const scope = targetOrgId ?? homeOrgId;
  return queryOptions({
    // cached under the tenant being viewed
    queryKey: [...bbKeys(scope).agents.list, ...listingKeySuffix(options)],
    queryFn: () => fetchAgents(getCtx(), targetOrgId, options),
  });
}
export function useAgents(targetOrgId?: string, options?: AdminListingOptions) {
  const { getAuthContext, orgId } = useBBContext();
  return useQuery(agentsQueryOptions(getAuthContext, orgId, targetOrgId, options));
}

// ── capabilities (cross-tenant aware) ─────────────────────────────────────────────
export function capabilitiesQueryOptions(
  getCtx: () => AuthContext,
  homeOrgId: string,
  targetOrgId?: string,
  options?: AdminListingOptions,
) {
  const scope = targetOrgId ?? homeOrgId;
  return queryOptions({
    queryKey: [...bbKeys(scope).capabilities.list, ...listingKeySuffix(options)],
    queryFn: () => fetchCapabilities(getCtx(), targetOrgId, options),
  });
}
export function useCapabilities(targetOrgId?: string, options?: AdminListingOptions) {
  const { getAuthContext, orgId } = useBBContext();
  return useQuery(capabilitiesQueryOptions(getAuthContext, orgId, targetOrgId, options));
}

// ── tenant config (cross-tenant aware) ─────────────────────────────────────────────
export function tenantConfigQueryOptions(
  getCtx: () => AuthContext,
  homeOrgId: string,
  targetOrgId?: string,
) {
  const scope = targetOrgId ?? homeOrgId;
  return queryOptions({
    queryKey: bbKeys(scope).tenant.config,
    queryFn: () => getTenantConfig(getCtx(), targetOrgId),
  });
}
export function useTenantConfig(targetOrgId?: string) {
  const { getAuthContext, orgId } = useBBContext();
  return useQuery(tenantConfigQueryOptions(getAuthContext, orgId, targetOrgId));
}

// ── conversation detail ────────────────────────────────────────────────────────────
export function conversationDetailQueryOptions(
  getCtx: () => AuthContext,
  orgId: string,
  convoId: string,
) {
  return queryOptions({
    queryKey: bbKeys(orgId).conversations.detail(convoId),
    queryFn: () => getConversationDetail(getCtx(), convoId),
    enabled: !!convoId,
  });
}
export function useConversationDetail(convoId: string) {
  const { getAuthContext, orgId } = useBBContext();
  return useQuery(conversationDetailQueryOptions(getAuthContext, orgId, convoId));
}

// ── conversation attachments (polls until processing settles) ──────────────────────
export function useConversationAttachments(convoId: string) {
  const { getAuthContext, orgId } = useBBContext();
  return useQuery({
    queryKey: bbKeys(orgId).conversations.attachments(convoId),
    queryFn: () => getConversationAttachments(getAuthContext(), convoId),
    enabled: !!convoId,
    refetchInterval: query => {
      const busy = query.state.data?.some(a => ["IN_PROGRESS", "LOADING"].includes(a.status ?? ""));
      return busy ? 2_000 : false; // poll while processing, then stop
    },
  });
}

// ── websearch ──────────────────────────────────────────────────────────────────────
export function useWebSearchProviders() {
  const { getAuthContext, orgId } = useBBContext();
  return useQuery({
    queryKey: bbKeys(orgId).websearch.providers,
    queryFn: () => getAvailableWebSearchProviders(getAuthContext()),
  });
}
export function useConversationWebSearch(convoId: string) {
  const { getAuthContext, orgId } = useBBContext();
  return useQuery({
    queryKey: bbKeys(orgId).conversations.websearch(convoId),
    queryFn: () => getConversationWebSearch(getAuthContext(), convoId),
    enabled: !!convoId,
  });
}

// ── messages (paginated history → useInfiniteQuery) ────────────────────────────────
export function messagesInfiniteOptions(
  getCtx: () => AuthContext,
  orgId: string,
  convoId: string,
  filters: { keyword?: string } = {},
  size = 20,
) {
  return infiniteQueryOptions({
    queryKey: bbKeys(orgId).messages.list(convoId, filters),
    queryFn: ({ pageParam }) =>
      getMessageList(getCtx(), convoId, { keyword: filters.keyword, page: pageParam, size }),
    initialPageParam: 1, // v5 requires this explicitly
    getNextPageParam: (lastPage: MessageListBody, allPages, lastPageParam) => {
      const total = lastPage.total ?? 0;
      const loaded = allPages.reduce((n, p) => n + p.data.length, 0);
      return loaded < total ? lastPageParam + 1 : undefined; // undefined ⇒ no more pages
    },
    enabled: !!convoId,
    staleTime: 0, // messages are live; treat the server as source of truth on open
    placeholderData: keepPreviousData, // smooth keyword-search transitions
  });
}
export function useMessages(convoId: string, filters?: { keyword?: string }) {
  const { getAuthContext, orgId } = useBBContext();
  return useInfiniteQuery(messagesInfiniteOptions(getAuthContext, orgId, convoId, filters));
}
