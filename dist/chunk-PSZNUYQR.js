import {
  isTokenExpired
} from "./chunk-CMFSLSL2.js";
import {
  OAUTH_BACKEND_URL
} from "./chunk-OPBRY7NV.js";

// src/settings/schema.ts
var DEFAULTS = {
  bbUrl: OAUTH_BACKEND_URL,
  bbToken: "",
  bbOrgId: "",
  bbBotId: "",
  bbBotName: "",
  useSystemPrompt: false,
  authMode: "oauth"
};

// src/settings/auth-mode.ts
function inferAuthMode(loaded) {
  if (loaded.authMode === "api-key" || loaded.authMode === "oauth") {
    return loaded.authMode;
  }
  if (loaded.bbToken && loaded.bbToken.length > 0) {
    return "api-key";
  }
  return "oauth";
}
function getAuthContext(settings, tokens, config = {}) {
  if (tokens?.accessToken && settings.bbOrgId && !isTokenExpired(tokens.expirationMs)) {
    return {
      baseUrl: config.oauthBaseUrl ?? OAUTH_BACKEND_URL,
      token: tokens.accessToken,
      orgId: settings.bbOrgId,
      mode: "oauth"
    };
  }
  if (settings.bbToken) {
    return {
      baseUrl: settings.bbUrl,
      token: settings.bbToken,
      orgId: settings.bbOrgId || "",
      mode: "api-key"
    };
  }
  return null;
}
function hasUsableAuth(settings, tokens) {
  return getAuthContext(settings, tokens) !== null;
}

export {
  DEFAULTS,
  inferAuthMode,
  getAuthContext,
  hasUsableAuth
};
//# sourceMappingURL=chunk-PSZNUYQR.js.map