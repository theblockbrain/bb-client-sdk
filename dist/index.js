import {
  DEFAULTS,
  getAuthContext,
  hasUsableAuth,
  inferAuthMode
} from "./chunk-PSZNUYQR.js";
import {
  createLock,
  extractCode,
  extractJson,
  repairUnescapedQuotes,
  siteKey
} from "./chunk-TC3463HT.js";
import {
  AVAILABLE_ACTIONS,
  runActions
} from "./chunk-TUTKA2JH.js";
import {
  beginBrowserLogin,
  completeBrowserLogin,
  createRefreshGuard,
  decodeJwtPayload,
  decodePKCEState,
  encodePKCEState,
  extractOrgIdFromClaims,
  extractProfile,
  generateChallenge,
  generateVerifier,
  login
} from "./chunk-ORUT47FY.js";
import {
  computeExpiration,
  exchangeCode,
  isTokenExpired,
  refreshTokens
} from "./chunk-CMFSLSL2.js";
import {
  AUTHORIZE_ENDPOINT,
  AUTH_AUTHORITY,
  AUTH_CLIENT_ID,
  AUTH_SCOPES,
  OAUTH_BACKEND_URL,
  TOKEN_ENDPOINT
} from "./chunk-OPBRY7NV.js";
import {
  BBApiError,
  authHeaders,
  createConversation,
  createNote,
  deleteConversation,
  discoverFrontendUrls,
  extractOrgIdFromIntrospect,
  fetchAgents,
  fetchBotList,
  fetchCapabilities,
  getAvailableWebSearchProviders,
  getConversationAttachments,
  getConversationWebSearch,
  getMessageList,
  getTenantById,
  getTenantConfig,
  introspectApiKey,
  isBBApiError,
  listTenants,
  normalizeUrl,
  sendMessage,
  setAgentActive,
  setAgentAvailability,
  setCapabilityActive,
  setCapabilityAvailability,
  setConversationWebSearch,
  setCustomAgentsEnabled,
  transcribeAudio,
  updateConversation,
  uploadConversationAttachment
} from "./chunk-3MG33L7I.js";
import {
  buildEmailPrompt,
  buildNewEmailPrompt,
  buildPagePrompt,
  parseResponse,
  parseSubjectAndBody
} from "./chunk-EFKOQZLN.js";
import {
  ACTION_SYSTEM_PROMPT
} from "./chunk-C25NYCKP.js";
import {
  applyTheme,
  configureLogo,
  cycleTheme,
  renderMarkdown,
  renderMarkdownInto,
  themeIcon,
  timeAgo
} from "./chunk-ZJIUWD7E.js";
export {
  ACTION_SYSTEM_PROMPT,
  AUTHORIZE_ENDPOINT,
  AUTH_AUTHORITY,
  AUTH_CLIENT_ID,
  AUTH_SCOPES,
  AVAILABLE_ACTIONS,
  BBApiError,
  DEFAULTS,
  OAUTH_BACKEND_URL,
  TOKEN_ENDPOINT,
  applyTheme,
  authHeaders,
  beginBrowserLogin,
  buildEmailPrompt,
  buildNewEmailPrompt,
  buildPagePrompt,
  completeBrowserLogin,
  computeExpiration,
  configureLogo,
  createConversation,
  createLock,
  createNote,
  createRefreshGuard,
  cycleTheme,
  decodeJwtPayload,
  decodePKCEState,
  deleteConversation,
  discoverFrontendUrls,
  encodePKCEState,
  exchangeCode,
  extractCode,
  extractJson,
  extractOrgIdFromClaims,
  extractOrgIdFromIntrospect,
  extractProfile,
  fetchAgents,
  fetchBotList,
  fetchCapabilities,
  generateChallenge,
  generateVerifier,
  getAuthContext,
  getAvailableWebSearchProviders,
  getConversationAttachments,
  getConversationWebSearch,
  getMessageList,
  getTenantById,
  getTenantConfig,
  hasUsableAuth,
  inferAuthMode,
  introspectApiKey,
  isBBApiError,
  isTokenExpired,
  listTenants,
  login,
  normalizeUrl,
  parseResponse,
  parseSubjectAndBody,
  refreshTokens,
  renderMarkdown,
  renderMarkdownInto,
  repairUnescapedQuotes,
  runActions,
  sendMessage,
  setAgentActive,
  setAgentAvailability,
  setCapabilityActive,
  setCapabilityAvailability,
  setConversationWebSearch,
  setCustomAgentsEnabled,
  siteKey,
  themeIcon,
  timeAgo,
  transcribeAudio,
  updateConversation,
  uploadConversationAttachment
};
//# sourceMappingURL=index.js.map