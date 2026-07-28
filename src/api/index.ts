// ── Agentic protocol ─────────────────────────────────────────────────────────
// `export *` (unlike every other line here) because `./agentic/index.ts` is
// itself a curated barrel — it already selects what is public, so re-listing its
// 26 symbols would only add drift. Also published directly as the `./agentic`
// subpath, so a non-React surface can take the protocol without the rest of ./api.
export * from "./agentic/index.js";
export type { Agent, AgentsResponse, ApiResponse } from "./agents.js";
// ── Feature-switches / admin config ──────────────────────────────────────────
export { fetchAgents, setAgentActive, setAgentAvailability } from "./agents.js";
export type { Bot, BotDetail } from "./bots.js";
export { fetchBotDetail, fetchBotList } from "./bots.js";
export type { CapabilitiesResponse, Capability } from "./capabilities.js";
export {
  fetchCapabilities,
  setCapabilityActive,
  setCapabilityAvailability,
} from "./capabilities.js";
export type {
  AttachmentUploadResult,
  ConversationDetail,
  UpdateConversationPatch,
  UploadAttachmentOptions,
} from "./conversations.js";
export {
  createConversation,
  deleteConversation,
  getConversationAttachments,
  getConversationDetail,
  updateConversation,
  uploadConversationAttachment,
} from "./conversations.js";
export { BBApiError, isBBApiError } from "./errors.js";
export { authHeaders } from "./headers.js";
export type { IntrospectResponse } from "./introspect.js";
export { extractOrgIdFromIntrospect, introspectApiKey } from "./introspect.js";
export type {
  GetMessageListOptions,
  MessageItem,
  MessageListBody,
  SendMessageOptions,
  SendMessageStreamOptions,
} from "./messages.js";
export { getMessageList, invalidateConvoDetailCache, sendMessage } from "./messages.js";
export type { CreateNoteParams, NoteResult } from "./notes.js";
export { createNote } from "./notes.js";
export type { MessageStream } from "./stream-result.js";
export { createMessageStream, wrapStringAsStream } from "./stream-result.js";
export type {
  ListTenantsOptions,
  ListTenantsResponse,
  TenantDetail,
  TenantSummary,
} from "./tenant.js";
export { discoverFrontendUrls, getTenantById, listTenants } from "./tenant.js";
export type { TenantConfig } from "./tenant-config.js";
export { getTenantConfig, setCustomAgentsEnabled } from "./tenant-config.js";
export { transcribeAudio } from "./transcribe.js";
export { normalizeUrl } from "./url.js";
export type {
  ConversationWebSearchSettings,
  WebSearchConfig,
  WebSearchProvider,
  WebSearchProviderStatus,
  WebSearchType,
} from "./websearch.js";
export {
  getAvailableWebSearchProviders,
  getConversationWebSearch,
  setConversationWebSearch,
} from "./websearch.js";
