import {
  subFromAccessToken
} from "./chunk-GEERJDH5.js";
import {
  isTokenExpired
} from "./chunk-IS5FIW7M.js";
import {
  OAUTH_BACKEND_URL
} from "./chunk-6GWCCXNN.js";

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
    const userId = config.userId ?? subFromAccessToken(tokens.accessToken) ?? void 0;
    return {
      baseUrl: config.oauthBaseUrl ?? OAUTH_BACKEND_URL,
      token: tokens.accessToken,
      orgId: settings.bbOrgId,
      mode: "oauth",
      userId
    };
  }
  if (settings.bbToken) {
    return {
      baseUrl: settings.bbUrl,
      token: settings.bbToken,
      orgId: settings.bbOrgId || "",
      mode: "api-key"
      // userId is intentionally absent in api-key mode — Agentic is OAuth-only
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
//# sourceMappingURL=chunk-VSQ7WUQF.js.map