import type { AuthContext } from "../settings/auth-mode.js";
import { request, requestJson, throwIfNotOk } from "./_send.js";
import { BBApiError } from "./errors.js";
import { authHeaders } from "./headers.js";
import { normalizeUrl } from "./url.js";

export type WebSearchProvider =
  | "linkup_normal_web_search"
  | "linkup_pro_web_search"
  | "linkup_pro_r_web_search"
  | "tavily_normal_web_search"
  | "tavily_pro_web_search"
  | "tavily_pro_r_web_search"
  | "perplexity_normal_web_search"
  | "perplexity_pro_web_search"
  | "perplexity_pro_r_web_search";

export type WebSearchType = "normal_web_search" | "pro_web_search" | "pro_r_web_search";

export interface WebSearchConfig {
  webSearchProvider: WebSearchProvider;
  /** Only relevant for Linkup providers. */
  isLinkupDeepSearch?: boolean;
}

export interface WebSearchProviderStatus {
  webSearchProvider: WebSearchProvider;
  tenantId: string;
  isEnable: boolean;
  isEnableByMaster: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConversationWebSearchSettings {
  enableWebSearch?: boolean;
  webSearchType?: WebSearchType;
  webSearchConfig?: WebSearchConfig;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Get available web search providers for the authenticated tenant.
 *
 * `GET /cortex/websearch/provider`
 *
 * The path was `/cortex/web-search/provider` until PDEV-7337 — a silent 404 no
 * test caught, because nothing asserted the URL. Blocky mounts the router at
 * `prefix="/websearch"` (`api/nexus/routes.py:91`), no hyphen.
 */
export async function getAvailableWebSearchProviders(
  ctx: AuthContext,
): Promise<WebSearchProviderStatus[]> {
  return requestJson<WebSearchProviderStatus[]>(ctx, {
    host: "blocky",
    path: "/cortex/websearch/provider",
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId),
  });
}

// ─── Conversation-level ───────────────────────────────────────────────────────

/**
 * Update web search settings for a conversation.
 * PATCH /cortex/conversation/{convoId}
 */
export async function setConversationWebSearch(
  ctx: AuthContext,
  convoId: string,
  settings: ConversationWebSearchSettings,
): Promise<void> {
  const endpoint = `/cortex/conversation/${convoId}`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(ctx.token, ctx.orgId),
    },
    body: JSON.stringify(settings),
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      /* response may not be JSON */
    }
    throw new BBApiError(`API ${res.status} at ${endpoint}`, res.status, {
      endpoint,
      responseBody: body,
    });
  }
}

/**
 * Read current web search settings for a conversation.
 * GET /cortex/conversation/{convoId}
 */
export async function getConversationWebSearch(
  ctx: AuthContext,
  convoId: string,
): Promise<ConversationWebSearchSettings> {
  const res = await request(ctx, {
    host: "blocky",
    path: `/cortex/conversation/${encodeURIComponent(convoId)}`,
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId),
  });
  await throwIfNotOk(res, `/cortex/conversation/${convoId}`);

  const data = await res.json<
    { body?: ConversationWebSearchSettings } & ConversationWebSearchSettings
  >();
  // Botticelli wraps in ResponseEntity { body: ... } or returns flat shape
  const payload = data.body ?? data;
  return {
    enableWebSearch: payload.enableWebSearch,
    webSearchType: payload.webSearchType,
    webSearchConfig: payload.webSearchConfig,
  };
}
