import { AuthContext } from '../settings/index.js';

/**
 * Build auth headers for BlockBrain API requests.
 * x-zitadel-org-id is sent whenever orgId is provided — required for tenant isolation.
 */
declare function authHeaders(token: string, orgId?: string | null): Record<string, string>;

/** Strip trailing slashes to avoid double-slash in URL paths. */
declare function normalizeUrl(url: string): string;

/**
 * Error thrown by SDK API calls on non-2xx HTTP responses or response-parsing failures.
 * Use `instanceof BBApiError` and check `.statusCode` to handle specific cases.
 */
declare class BBApiError extends Error {
    readonly statusCode: number;
    readonly endpoint?: string;
    readonly responseBody?: unknown;
    constructor(message: string, statusCode: number, options?: {
        endpoint?: string;
        responseBody?: unknown;
        cause?: unknown;
    });
}
/** Type guard for BBApiError. */
declare function isBBApiError(err: unknown): err is BBApiError;

interface IntrospectResponse {
    active: boolean;
    /** Zitadel resource-owner / org ID, required for multi-tenant endpoints like /sp2text. */
    "urn:zitadel:iam:user:resourceowner:id"?: string;
    [key: string]: unknown;
}
/**
 * Introspect an API key to verify it is active.
 * Only used in API-Key mode for connection testing.
 */
declare function introspectApiKey(baseUrl: string, token: string): Promise<IntrospectResponse>;
/** Pull the Zitadel org ID from an introspect response. Returns "" when absent. */
declare function extractOrgIdFromIntrospect(data: IntrospectResponse): string;

interface Bot {
    id: string;
    name: string;
    model: string;
}
/** Fetch the list of active bots for the authenticated context. */
declare function fetchBotList(ctx: AuthContext): Promise<Bot[]>;

/** Create a new conversation for a bot. Returns the conversation ID. */
declare function createConversation(ctx: AuthContext, botId: string, convoName?: string): Promise<{
    convoId: string;
}>;

interface SendMessageOptions {
    /** Enable streaming mode. Default: false. */
    enableStreaming?: boolean;
}
/**
 * Send user input to a conversation and get the bot response.
 * Returns the response content string.
 */
declare function sendMessage(ctx: AuthContext, convoId: string, content: string, options?: SendMessageOptions): Promise<string>;
interface MessageItem {
    content: string;
    role: string;
    [k: string]: unknown;
}
interface MessageListBody {
    data: MessageItem[];
    total?: number;
    page?: number;
}
interface GetMessageListOptions {
    keyword?: string;
    page?: number;
    size?: number;
}
/**
 * Fetch paginated message history for a conversation.
 * POST /cortex/message/list
 *
 * Defaults: keyword="", page=1, size=20.
 */
declare function getMessageList(ctx: AuthContext, convoId: string, options?: GetMessageListOptions): Promise<MessageListBody>;

/**
 * Transcribe an audio blob via the BlockBrain sp2text endpoint.
 *
 * The browser sets the multipart/form-data Content-Type header with boundary automatically —
 * do NOT override it. x-zitadel-org-id is handled via authHeaders(ctx).
 */
declare function transcribeAudio(ctx: AuthContext, audio: Blob, filename?: string, model?: string): Promise<string>;

/**
 * Discover frontend URLs available for the authenticated tenant.
 * GET /user-tenant/domains
 *
 * Handles multiple response envelope shapes:
 *   { content: string[] }  — standard ResponseEntity
 *   { body: string[] }     — legacy envelope
 *   string[]               — flat array
 *
 * Returns null when the endpoint fails or returns no domains.
 */
declare function discoverFrontendUrls(baseUrl: string, token: string, orgId?: string | null): Promise<string[] | null>;
interface TenantSummary {
    /** MongoDB _id, mapped from the raw _id field. */
    id: string;
    tenantName: string;
    database: string;
    activePlan?: string;
    domain: string;
    acceptSuffix: string[];
}
interface TenantDetail extends TenantSummary {
    /** Only available from getTenantById — not present in listTenants. */
    zitadelOrgId: string;
}
interface ListTenantsResponse {
    totalCount: number;
    currentPage: number;
    data: TenantSummary[];
}
interface ListTenantsOptions {
    /** Filter by tenant name (server-side substring match). Default: no filter. */
    name?: string;
    /** 1-based page number. Default: 1. */
    page?: number;
    /** Page size. Default: 20. */
    size?: number;
}
/**
 * List BB tenants. Admin-only — requires a token issued for the Blockbrain master org.
 * GET /tenant
 *
 * zitadelOrgId is NOT in the list response. If you need it for a specific tenant,
 * call getTenantById(ctx, tenant.id) to fetch it.
 */
declare function listTenants(ctx: AuthContext, options?: ListTenantsOptions): Promise<ListTenantsResponse>;
/**
 * Fetch full detail for a single tenant, including zitadelOrgId.
 * GET /tenant/{tenantId}
 *
 * Use this after listTenants when you need the zitadelOrgId to make
 * tenant-scoped API calls (x-zitadel-org-id header).
 */
declare function getTenantById(ctx: AuthContext, tenantId: string): Promise<TenantDetail>;

type WebSearchProvider = "linkup_normal_web_search" | "linkup_pro_web_search" | "linkup_pro_r_web_search" | "tavily_normal_web_search" | "tavily_pro_web_search" | "tavily_pro_r_web_search" | "perplexity_normal_web_search" | "perplexity_pro_web_search" | "perplexity_pro_r_web_search";
type WebSearchType = "normal_web_search" | "pro_web_search" | "pro_r_web_search";
interface WebSearchConfig {
    webSearchProvider: WebSearchProvider;
    /** Only relevant for Linkup providers. */
    isLinkupDeepSearch?: boolean;
}
interface WebSearchProviderStatus {
    webSearchProvider: WebSearchProvider;
    tenantId: string;
    isEnable: boolean;
    isEnableByMaster: boolean;
    createdAt?: string;
    updatedAt?: string;
}
interface ConversationWebSearchSettings {
    enableWebSearch?: boolean;
    webSearchType?: WebSearchType;
    webSearchConfig?: WebSearchConfig;
}
/**
 * Get available web search providers for the authenticated tenant.
 * GET /cortex/web-search/provider
 */
declare function getAvailableWebSearchProviders(ctx: AuthContext): Promise<WebSearchProviderStatus[]>;
/**
 * Update web search settings for a conversation.
 * PATCH /cortex/conversation/{convoId}
 */
declare function setConversationWebSearch(ctx: AuthContext, convoId: string, settings: ConversationWebSearchSettings): Promise<void>;
/**
 * Read current web search settings for a conversation.
 * GET /cortex/conversation/{convoId}
 */
declare function getConversationWebSearch(ctx: AuthContext, convoId: string): Promise<ConversationWebSearchSettings>;

export { BBApiError, type Bot, type ConversationWebSearchSettings, type GetMessageListOptions, type IntrospectResponse, type ListTenantsOptions, type ListTenantsResponse, type MessageItem, type MessageListBody, type SendMessageOptions, type TenantDetail, type TenantSummary, type WebSearchConfig, type WebSearchProvider, type WebSearchProviderStatus, type WebSearchType, authHeaders, createConversation, discoverFrontendUrls, extractOrgIdFromIntrospect, fetchBotList, getAvailableWebSearchProviders, getConversationWebSearch, getMessageList, getTenantById, introspectApiKey, isBBApiError, listTenants, normalizeUrl, sendMessage, setConversationWebSearch, transcribeAudio };
