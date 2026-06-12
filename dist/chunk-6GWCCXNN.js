// src/config.ts
var AUTH_AUTHORITY = "https://auth.theblockbrain.ai";
var OAUTH_BACKEND_URL = "https://blocky.theblockbrain.ai";
var AUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "blockbrain:grants"
];
var TOKEN_ENDPOINT = `${AUTH_AUTHORITY}/oauth/v2/token`;
var AUTHORIZE_ENDPOINT = `${AUTH_AUTHORITY}/oauth/v2/authorize`;
var AGENTIC_BASE_URL = "https://agentic.theblockbrain.ai/api";

export {
  AUTH_AUTHORITY,
  OAUTH_BACKEND_URL,
  AUTH_SCOPES,
  TOKEN_ENDPOINT,
  AUTHORIZE_ENDPOINT,
  AGENTIC_BASE_URL
};
//# sourceMappingURL=chunk-6GWCCXNN.js.map