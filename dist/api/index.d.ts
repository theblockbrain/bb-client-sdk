import { AuthContext } from '../settings/index.js';

/**
 * Build auth headers for BlockBrain API requests.
 * x-zitadel-org-id is sent whenever orgId is provided — required for tenant isolation.
 *
 * NOTE: Does NOT set Content-Type. For JSON bodies callers add it explicitly;
 * for multipart/form-data (see uploadConversationAttachment) it must NOT be set
 * manually — the runtime derives the boundary from the FormData body automatically.
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
/**
 * Routing-relevant fields from a single bot record.
 * `agent` is the Mastra agent ID — when set, conversations for this bot
 * must carry `agent` in their create payload so `sendMessage` routes to
 * the Agentic path.
 */
interface BotDetail {
    id: string;
    name: string;
    model: string;
    /** Mastra agent ID; empty string or null when the bot is LLM-only. */
    agent: string | null;
    /** Custom agent ID (distinct from the Mastra agent). */
    customAgentId: string | null;
}
/** Fetch the list of active bots for the authenticated context. */
declare function fetchBotList(ctx: AuthContext): Promise<Bot[]>;
/**
 * Fetch routing-relevant detail for a single bot.
 *
 * GET /cortex/active-bot/{botId}
 *
 * Used internally by `createConversation` to propagate the bot's `agent`
 * field to the new conversation — required so `sendMessage` can route to
 * the Agentic path. Callers that only need the basic `Bot` shape should
 * use `fetchBotList` instead.
 */
declare function fetchBotDetail(ctx: AuthContext, botId: string): Promise<BotDetail>;

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

/**
 * Subset of `ConvoGeneralInfoDTO` (blocky/src/api/nexus/conversation/schemas.py)
 * that the SDK needs for routing decisions.
 *
 * `agent` — when set, the conversation is wired to an Agentic agent and
 * `sendMessage` will route to the Agentic stream endpoint instead of Blocky.
 *
 * Note: `botId` is NOT returned by `/general-info` — the header
 * `X-BLOCKBRAIN-ACTIVE-BOT-ID` is sent conditionally and only when the caller
 * supplies it explicitly.
 */
interface ConversationDetail {
    /** Agentic agent ID when the conversation has an agent configured; null/undefined otherwise. */
    agent?: string | null;
    /** Custom agent ID (separate from the Mastra agent ID in `agent`). */
    customAgentId?: string | null;
}
/**
 * Fetch lightweight conversation metadata used for routing.
 *
 * GET /cortex/conversation/{convoId}/general-info
 *
 * The response is intentionally narrow — only fields the SDK uses for internal
 * routing are surfaced; callers that need richer detail should use their own
 * frontend repository directly.
 */
declare function getConversationDetail(ctx: AuthContext, convoId: string): Promise<ConversationDetail>;
/**
 * Create a new conversation for a bot. Returns the conversation ID.
 *
 * Fetches the bot's `agent` field from `GET /cortex/active-bot/{botId}` and
 * includes it in the create payload when non-empty. This is required for
 * `sendMessage` to route to the Agentic path — the backend only persists
 * `agent` on the conversation when the field is present at create time.
 * Mirrors the behaviour of `CortexRepository.createConvoOfCortexBot` in
 * v1-frontend (spreads `options` including `agent` into the POST body).
 */
declare function createConversation(ctx: AuthContext, botId: string, convoName?: string): Promise<{
    convoId: string;
}>;
/**
 * Delete a conversation by ID.
 * Should be called in a finally block after each batch file pipeline to avoid
 * leaving orphaned conversations in the user's tenant.
 *
 * DELETE /cortex/conversation/:convoId
 */
declare function deleteConversation(ctx: AuthContext, convoId: string): Promise<void>;
/**
 * Shape mirrors v1-frontend `UploadedFile` (lib/firestore-types.ts) plus
 * additional fields observed in the live API response.
 * Backend wraps the DTO in a CommonResponseDTO envelope: `{ code, key, body: AttachedFilesDTO }`.
 */
interface AttachmentUploadResult {
    _id: string;
    name: string;
    tokens: number;
    enabled: boolean;
    createdAt: string;
    modifiedAt: string;
    status: string;
    success?: boolean;
    errorMessage?: string | null;
    calculatedStatus?: string;
    /** Detected file type, e.g. "TEXT", "IMAGE". */
    fileType?: string;
    url?: string | null;
    originUrl?: string | null;
    thumbUrl?: string | null;
    isDeleted?: boolean;
    /** Whether the file was processed with Smart OCR. */
    isSmartOcr?: boolean;
    /** Key used to detect and handle duplicate uploads. */
    uploadKey?: string | null;
    /** Conversation this attachment belongs to. */
    convoId?: string;
    /** Data room this attachment belongs to (when promoted). */
    dataroomId?: string | null;
    /** Whether the attachment has been permanently saved to a data room. */
    isSaved?: boolean;
    archivedAt?: string | null;
    dataRetentionConfig?: unknown;
}
/**
 * Optional parameters for `uploadConversationAttachment`.
 * All map directly to backend Form fields in `direct_upload_attachment`
 * (blocky/src/api/nexus/conversation/routes.py).
 * When omitted, the backend applies its own defaults.
 */
interface UploadAttachmentOptions {
    /**
     * Run AWS Textract OCR on PDFs and images for higher-fidelity text extraction.
     * Backend default: true for PDF/image, false for plain text.
     */
    isSmartOcr?: boolean;
    /**
     * When a file with the same name already exists in the conversation:
     * keep both files side-by-side. Mutually exclusive with `isOverwriteDuplicate`.
     */
    isKeepBothDuplicate?: boolean;
    /**
     * When a file with the same name already exists in the conversation:
     * overwrite the existing file. Mutually exclusive with `isKeepBothDuplicate`.
     */
    isOverwriteDuplicate?: boolean;
    /**
     * Opaque key for grouping or deduplicating uploads on the server side.
     * Distinct from `sessionId` — used by callers that manage upload identity
     * independently of the session grouping.
     */
    uploadKey?: string;
}
/**
 * Upload a file as an attachment to an existing conversation.
 * The file is processed and made available as context for subsequent messages.
 *
 * POST /cortex/conversation/:convoId/attachment (multipart/form-data)
 * Backend route: blocky/src/api/nexus/conversation/routes.py — `direct_upload_attachment`
 *
 * @param file      - A `File` (browser) or `Blob` with a `.name` property. In Bun/Node,
 *                    pass `new File([buffer], filename, { type: mimeType })`.
 * @param sessionId - Fresh UUID per batch. Groups concurrent uploads in the backend
 *                    processing pipeline. Required by the backend.
 * @param options   - Optional upload behaviour overrides (OCR, duplicate handling, etc.).
 *
 * NOTE: Do NOT add `Content-Type` to the headers object — the multipart boundary
 * must be set by the runtime when a `FormData` body is provided. See `authHeaders`
 * in headers.ts for context.
 */
declare function uploadConversationAttachment(ctx: AuthContext, convoId: string, file: File | Blob, sessionId: string, options?: UploadAttachmentOptions): Promise<AttachmentUploadResult>;
/**
 * Returns all attachments for a conversation.
 * Used to poll until the backend finishes processing uploaded files
 * (status transitions from "IN_PROGRESS" / "LOADING" to "COMPLETED" / "SUCCESS" / "FAILED").
 *
 * Status values observed in production (from v1-frontend constants):
 *   "IN_PROGRESS" | "LOADING"             — still processing
 *   "COMPLETED"   | "SUCCESS"             — ready for LLM use
 *   "ERROR"       | "FAILED"              — processing failed
 *
 * GET /cortex/conversation/:convoId/attachment
 */
declare function getConversationAttachments(ctx: AuthContext, convoId: string): Promise<AttachmentUploadResult[]>;
/**
 * Partial-update patch for a conversation.
 * All fields are optional — only the fields present in the body are applied.
 *
 * Mirrors the `CortexConvoUpdateRequest` schema from
 * blocky/src/api/nexus/conversation/schemas.py.
 * Backend accepts camelCase aliases (populate_by_name=True + alias fields).
 *
 * Common use-cases:
 *  - Enable web search:  { enableWebSearch: true, webSearchType: "normal_web_search" }
 *  - Rename:             { name: "My Conversation" }
 *  - Swap model:         { model: "gpt-4o" }
 */
interface UpdateConversationPatch {
    /** Rename the conversation. */
    name?: string;
    /** Enable/disable web search for this conversation. */
    enableWebSearch?: boolean;
    /**
     * Web search provider type. Values match the backend `WebSearchType` enum:
     * "normal_web_search" | "linkup_pro_web_search" | "linkup_pro_r_web_search" | …
     * Use the `WebSearchType` union from websearch.ts for safe values.
     */
    webSearchType?: WebSearchType;
    /** Fine-grained web search provider configuration (provider key, deep-search flag). */
    webSearchConfig?: WebSearchConfig;
    /** Enable semantic reranker for retrieval. */
    enableReranker?: boolean;
    /** Enable agentic retrieval mode. */
    enableAgentRetrieval?: boolean;
    /** Override the AI model for this conversation. */
    model?: string;
    /** Enable image generation responses. */
    enableGenerateImage?: boolean;
    /** Enable auto-response mode (bot replies without explicit send). */
    enableAutoResponse?: boolean;
    /** Response length preset. */
    lengthPreset?: string;
}
/**
 * Apply a partial update to an existing conversation.
 * Returns void — callers that need the updated state should re-fetch
 * via `getConversationWebSearch` or a dedicated GET endpoint.
 *
 * PATCH /cortex/conversation/{convoId}
 * Backend: blocky/src/api/nexus/conversation/routes.py — `update_convo_detail`
 */
declare function updateConversation(ctx: AuthContext, convoId: string, patch: UpdateConversationPatch): Promise<void>;

interface CreateNoteParams {
    title: string;
    summary: string;
    parentPath?: string;
    isAiGenerated?: boolean;
}
/**
 * Result shape mirrors `NoteShortDTO` (extends `BaseDTO`) from
 * blocky/src/api/nexus/notes/schemas.py.
 * The route returns a ResponseEntity envelope: { code, key, body: NoteShortDTO }.
 */
interface NoteResult {
    _id: string;
    title: string;
    isEdited: boolean;
    createdAt: string;
    modifiedAt: string;
}
/**
 * Save a note (insight) to the authenticated user's Blockbrain workspace.
 *
 * POST /cortex/notes/add-note
 * Backend: blocky/src/api/nexus/notes/routes.py — `add_chat_note_manual`
 * Body schema: NoteCreateDTO (title, summary, parent_path?, is_ai_generated?)
 *
 * Field names are snake_case as required by the backend model
 * (`BlockyBaseModel` populates by field name, not alias, for POST bodies).
 */
declare function createNote(ctx: AuthContext, params: CreateNoteParams): Promise<NoteResult>;

/**
 * Shared streaming result shape used by both the Blocky and Agentic send paths.
 *
 * `sendMessage` with `enableStreaming: true` resolves to this type regardless
 * of which backend handled the request — callers get a unified interface.
 */
interface MessageStream {
    /**
     * Async iterable that yields text deltas as they arrive.
     *
     * For Blocky without true SSE: yields a single string containing the full
     * response (the endpoint returns JSON, not a stream). The `final` promise
     * resolves to the same value.
     *
     * For Agentic: yields incremental `text-delta` chunks from the SSE stream.
     */
    textDeltas: AsyncIterable<string>;
    /**
     * Resolves to the fully assembled response text when the stream is complete.
     *
     * `final` resolves independently of whether `textDeltas` is consumed — it is
     * safe to await `final` without iterating `textDeltas`, and vice versa.
     * An internal drain runs automatically so callers are never deadlocked.
     *
     * Rejects if the underlying source throws during reading.
     */
    final: Promise<string>;
}
/**
 * Wrap a single pre-resolved string into a `MessageStream`.
 *
 * Used by the Blocky path when `enableStreaming: true` is requested but the
 * Blocky endpoint returns a JSON response (no actual SSE).
 */
declare function wrapStringAsStream(text: string): MessageStream;
/**
 * Build a `MessageStream` from an `AsyncIterable<string>` of text deltas.
 *
 * The source is drained by an internal background task immediately on creation,
 * so `final` resolves regardless of whether `textDeltas` is consumed:
 *
 *   // Only final:
 *   const text = await stream.final;
 *
 *   // Only deltas:
 *   for await (const d of stream.textDeltas) { ... }
 *
 *   // Both (concurrent):
 *   for await (const d of stream.textDeltas) { ... }
 *   const text = await stream.final; // already resolved by the time the loop exits
 *
 * `textDeltas` yields each delta as it arrives from the internal queue.
 * If the caller does not iterate `textDeltas`, the queue grows but is bounded
 * by the source length — acceptable for the typical chat-response size.
 */
declare function createMessageStream(source: AsyncIterable<string>): MessageStream;

/**
 * Approval context passed to the resolver on a tool-call-approval event.
 * Shape mirrors the `data` payload of the `data-tool-call-approval` SSE frame.
 */
interface ApprovalContext {
    runId?: string;
    toolCallId?: string;
    toolName?: string;
    [key: string]: unknown;
}
/**
 * Suspension context passed to the resolver on a tool-call-suspended event.
 * The resolver must return an answer map or signal cancellation.
 */
interface SuspendContext {
    runId?: string;
    toolCallId?: string;
    [key: string]: unknown;
}
interface ApprovalResult {
    approved: boolean;
}
interface SuspendResult {
    answers?: Record<string, string>;
    cancelled?: boolean;
}
/**
 * Strategy interface for handling tool-call approval and ask-user-question events.
 *
 * Replace the default `autoApprove` implementation to surface prompts to users.
 * The call path is unchanged — only the resolver impl changes.
 */
interface ApprovalResolver {
    resolveApproval(ctx: ApprovalContext): Promise<ApprovalResult>;
    resolveSuspend(ctx: SuspendContext): Promise<SuspendResult>;
}

interface SendMessageOptions {
    /** Enable streaming mode. Default: false. */
    enableStreaming?: boolean;
    /**
     * Tool-call approval resolver for Agentic turns.
     * Default: `autoApproveResolver` (auto-approves all tool calls).
     * Replace to surface approval prompts to users without changing the call signature.
     */
    approvalResolver?: ApprovalResolver;
}
interface SendMessageStreamOptions extends SendMessageOptions {
    enableStreaming: true;
}
/** Evict a cached conversation (e.g. when the agent assignment changes). */
declare function invalidateConvoDetailCache(convoId: string): void;
/**
 * Send user input to a conversation and get the bot response.
 *
 * Routes automatically between Blocky and the Agentic API based on whether
 * the conversation has an agent configured — determined by a call to
 * `GET /cortex/conversation/{convoId}/general-info`.
 *
 * **Routing cache:** the agent assignment for each `convoId` is cached in memory
 * for up to 5 minutes. If the agent of a conversation is changed mid-session
 * (added or removed), routing continues to use the cached value until the TTL
 * expires. Call `invalidateConvoDetailCache(convoId)` after changing a
 * conversation's agent assignment to force an immediate re-fetch.
 *
 * @overload Non-streaming (default) — returns the full response as a string.
 */
declare function sendMessage(ctx: AuthContext, convoId: string, content: string, options?: SendMessageOptions & {
    enableStreaming?: false;
}): Promise<string>;
/**
 * @overload Streaming — returns a `MessageStream` with `textDeltas` and `final`.
 * Both Blocky and Agentic paths produce the same shape; the Blocky path yields a
 * single-delta stream if the Blocky endpoint does not support true SSE.
 */
declare function sendMessage(ctx: AuthContext, convoId: string, content: string, options: SendMessageStreamOptions): Promise<MessageStream>;
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

interface Agent {
    id: string;
    name: string;
    active: boolean;
    available: boolean;
    capabilityIds?: string[];
}
interface ApiResponse {
    ok: boolean;
    error?: string;
}
/** API response shape: Record<agentId, Agent> */
type AgentsResponse = Record<string, Agent>;
/**
 * Fetch all agents for the org (includes inactive and unavailable).
 * GET /agents?includeInactive=true&includeUnavailable=true&orgId=...
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 *   For cross-tenant admin calls, pass the target's orgId while ctx.orgId
 *   remains the user's home org (used for x-zitadel-org-id header auth).
 */
declare function fetchAgents(ctx: AuthContext, targetOrgId?: string): Promise<AgentsResponse>;
/**
 * Set the active flag for a single agent.
 * PATCH /agents/set-active?orgId=...
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 */
declare function setAgentActive(ctx: AuthContext, agentId: string, active: boolean, targetOrgId?: string): Promise<ApiResponse>;
/**
 * Set the availability flag for a single agent.
 * PATCH /agents/set-availability?orgId=...
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 */
declare function setAgentAvailability(ctx: AuthContext, agentId: string, available: boolean, targetOrgId?: string): Promise<ApiResponse>;

interface Capability {
    id: string;
    name: string;
    active: boolean;
    available: boolean;
}
/** API response shape: Record<capabilityId, Capability> */
type CapabilitiesResponse = Record<string, Capability>;
/**
 * Fetch all capabilities for the org (includes inactive and unavailable).
 * GET /capabilities?includeInactive=true&includeUnavailable=true&orgId=...
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 *   For cross-tenant admin calls, pass the target's orgId while ctx.orgId
 *   remains the user's home org (used for x-zitadel-org-id header auth).
 */
declare function fetchCapabilities(ctx: AuthContext, targetOrgId?: string): Promise<CapabilitiesResponse>;
/**
 * Set the active flag for a single capability.
 * PATCH /capabilities/set-active?orgId=...
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 */
declare function setCapabilityActive(ctx: AuthContext, capabilityId: string, active: boolean, targetOrgId?: string): Promise<ApiResponse>;
/**
 * Set the availability flag for a single capability.
 * PATCH /capabilities/set-availability?orgId=...
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 */
declare function setCapabilityAvailability(ctx: AuthContext, capabilityId: string, available: boolean, targetOrgId?: string): Promise<ApiResponse>;

interface TenantConfig {
    customAgentsEnabled: boolean;
}
/**
 * Fetch tenant config for the org.
 * GET /tenants?orgId=...
 * Returns { id, name, config: { customAgentsEnabled, ... } | null }
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 *   For cross-tenant admin calls, pass the target's orgId while ctx.orgId
 *   remains the user's home org (used for x-zitadel-org-id header auth).
 */
declare function getTenantConfig(ctx: AuthContext, targetOrgId?: string): Promise<TenantConfig>;
/**
 * Toggle the customAgentsEnabled flag for a tenant.
 * PATCH /tenants/config?orgId=...
 *
 * @param targetOrgId - Target tenant org. Defaults to ctx.orgId (self-tenant).
 */
declare function setCustomAgentsEnabled(ctx: AuthContext, enabled: boolean, targetOrgId?: string): Promise<void>;

export { type Agent, type AgentsResponse, type ApiResponse, type AttachmentUploadResult, BBApiError, type Bot, type BotDetail, type CapabilitiesResponse, type Capability, type ConversationDetail, type ConversationWebSearchSettings, type CreateNoteParams, type GetMessageListOptions, type IntrospectResponse, type ListTenantsOptions, type ListTenantsResponse, type MessageItem, type MessageListBody, type MessageStream, type NoteResult, type SendMessageOptions, type SendMessageStreamOptions, type TenantConfig, type TenantDetail, type TenantSummary, type UpdateConversationPatch, type UploadAttachmentOptions, type WebSearchConfig, type WebSearchProvider, type WebSearchProviderStatus, type WebSearchType, authHeaders, createConversation, createMessageStream, createNote, deleteConversation, discoverFrontendUrls, extractOrgIdFromIntrospect, fetchAgents, fetchBotDetail, fetchBotList, fetchCapabilities, getAvailableWebSearchProviders, getConversationAttachments, getConversationDetail, getConversationWebSearch, getMessageList, getTenantById, getTenantConfig, introspectApiKey, invalidateConvoDetailCache, isBBApiError, listTenants, normalizeUrl, sendMessage, setAgentActive, setAgentAvailability, setCapabilityActive, setCapabilityAvailability, setConversationWebSearch, setCustomAgentsEnabled, transcribeAudio, updateConversation, uploadConversationAttachment, wrapStringAsStream };
