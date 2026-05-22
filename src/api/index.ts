export { authHeaders } from "./headers.js";
export { normalizeUrl } from "./url.js";
export { BBApiError, isBBApiError } from "./errors.js";
export { introspectApiKey, extractOrgIdFromIntrospect } from "./introspect.js";
export type { IntrospectResponse } from "./introspect.js";
export { fetchBotList } from "./bots.js";
export type { Bot } from "./bots.js";
export { createConversation, deleteConversation, uploadConversationAttachment, getConversationAttachments, updateConversation } from "./conversations.js";
export type { AttachmentUploadResult, UploadAttachmentOptions, UpdateConversationPatch } from "./conversations.js";
export { createNote } from "./notes.js";
export type { CreateNoteParams, NoteResult } from "./notes.js";
export { sendMessage, getMessageList } from "./messages.js";
export type { SendMessageOptions, MessageItem, MessageListBody, GetMessageListOptions } from "./messages.js";
export { transcribeAudio } from "./transcribe.js";
export { discoverFrontendUrls, listTenants, getTenantById } from "./tenant.js";
export type { TenantSummary, TenantDetail, ListTenantsResponse, ListTenantsOptions } from "./tenant.js";
export {
  getAvailableWebSearchProviders,
  setConversationWebSearch,
  getConversationWebSearch,
} from "./websearch.js";
export type {
  WebSearchProvider,
  WebSearchType,
  WebSearchConfig,
  WebSearchProviderStatus,
  ConversationWebSearchSettings,
} from "./websearch.js";
// ── Feature-switches / admin config ──────────────────────────────────────────
export { fetchAgents, setAgentActive, setAgentAvailability } from "./agents.js";
export type { Agent, AgentsResponse, ApiResponse } from "./agents.js";
export { fetchCapabilities, setCapabilityActive, setCapabilityAvailability } from "./capabilities.js";
export type { Capability, CapabilitiesResponse } from "./capabilities.js";
export { getTenantConfig, setCustomAgentsEnabled } from "./tenant-config.js";
export type { TenantConfig } from "./tenant-config.js";
