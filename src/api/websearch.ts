import type { AuthContext } from "../settings/auth-mode.js";
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
 * GET /cortex/web-search/provider
 */
export async function getAvailableWebSearchProviders(
  ctx: AuthContext,
): Promise<WebSearchProviderStatus[]> {
  const endpoint = "/cortex/web-search/provider";
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId),
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

  return (await res.json()) as WebSearchProviderStatus[];
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
  const endpoint = `/cortex/conversation/${convoId}`;
  const url = normalizeUrl(ctx.baseUrl);
  const res = await fetch(`${url}${endpoint}`, {
    method: "GET",
    headers: authHeaders(ctx.token, ctx.orgId),
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

  const data = (await res.json()) as {
    body?: ConversationWebSearchSettings;
  } & ConversationWebSearchSettings;
  // Botticelli wraps in ResponseEntity { body: ... } or returns flat shape
  const payload = data.body ?? data;
  return {
    enableWebSearch: payload.enableWebSearch,
    webSearchType: payload.webSearchType,
    webSearchConfig: payload.webSearchConfig,
  };
}
