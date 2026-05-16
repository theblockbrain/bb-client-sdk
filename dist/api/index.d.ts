import { AuthContext } from '../settings/index.js';

/**
 * Build auth headers for BlockBrain API requests.
 * x-zitadel-org-id is sent whenever orgId is provided — required for tenant isolation.
 */
declare function authHeaders(token: string, orgId?: string | null): Record<string, string>;

/** Strip trailing slashes to avoid double-slash in URL paths. */
declare function normalizeUrl(url: string): string;

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

export { type Bot, type IntrospectResponse, type SendMessageOptions, authHeaders, createConversation, discoverFrontendUrls, extractOrgIdFromIntrospect, fetchBotList, introspectApiKey, normalizeUrl, sendMessage, transcribeAudio };
