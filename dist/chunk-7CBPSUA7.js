import {
  computeExpiration,
  exchangeCode
} from "./chunk-IS5FIW7M.js";
import {
  AUTHORIZE_ENDPOINT,
  AUTH_SCOPES,
  TOKEN_ENDPOINT
} from "./chunk-6GWCCXNN.js";

// src/auth/pkce.ts
function base64urlEncode(buf) {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (const byte of bytes) {
    str += String.fromCharCode(byte);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function generateVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes.buffer);
}
function generateStateNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes.buffer);
}
async function generateChallenge(verifier) {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64urlEncode(digest);
}
function encodePKCEState(state) {
  const json = JSON.stringify(state);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function decodePKCEState(encoded) {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(base64);
  return JSON.parse(json);
}

// src/auth/jwt.ts
function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  } catch {
    return null;
  }
}
function extractOrgIdFromClaims(claims) {
  const direct = claims["urn:zitadel:iam:org:id"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const resourceOwner = claims["urn:zitadel:iam:user:resourceowner:id"];
  if (typeof resourceOwner === "string" && resourceOwner.length > 0) return resourceOwner;
  const roles = claims["urn:zitadel:iam:org:project:roles"];
  if (roles !== null && typeof roles === "object") {
    const firstRole = Object.values(roles)[0];
    if (firstRole !== null && typeof firstRole === "object") {
      const firstOrgKey = Object.keys(firstRole)[0];
      if (firstOrgKey) return firstOrgKey;
    }
  }
  return null;
}
function extractProfile(idToken, accessToken) {
  const idClaims = decodeJwtPayload(idToken) ?? {};
  let orgId = extractOrgIdFromClaims(idClaims);
  if (!orgId && accessToken) {
    try {
      const accessClaims = decodeJwtPayload(accessToken);
      if (accessClaims) {
        orgId = extractOrgIdFromClaims(accessClaims);
      }
    } catch {
    }
  }
  return {
    sub: typeof idClaims.sub === "string" ? idClaims.sub : "",
    email: typeof idClaims.email === "string" ? idClaims.email : void 0,
    name: typeof idClaims.name === "string" ? idClaims.name : void 0,
    given_name: typeof idClaims.given_name === "string" ? idClaims.given_name : void 0,
    family_name: typeof idClaims.family_name === "string" ? idClaims.family_name : void 0,
    orgId
  };
}

// src/auth/login.ts
async function login(identity, options) {
  const {
    clientId,
    scopes = AUTH_SCOPES,
    authorizeEndpoint = AUTHORIZE_ENDPOINT,
    tokenEndpoint = TOKEN_ENDPOINT
  } = options;
  const redirectUri = identity.getRedirectUri();
  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  const state = generateStateNonce();
  const authUrl = new URL(authorizeEndpoint);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", [...scopes].join(" "));
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  const resultUrl = await identity.launchOAuthFlow(authUrl.toString());
  if (!resultUrl) throw new Error("No redirect URL returned from auth flow.");
  const params = new URL(resultUrl).searchParams;
  const error = params.get("error");
  if (error) {
    throw new Error(`Auth error: ${error} \u2014 ${params.get("error_description") ?? ""}`);
  }
  const code = params.get("code");
  if (!code) throw new Error("No authorization code in redirect.");
  const returnedState = params.get("state");
  if (!returnedState) throw new Error("Missing state in redirect \u2014 possible CSRF.");
  if (returnedState !== state) throw new Error("State mismatch \u2014 possible CSRF.");
  const tokens = await exchangeCode(code, verifier, redirectUri, clientId, tokenEndpoint);
  const profile = extractProfile(tokens.id_token, tokens.access_token);
  const expiresAt = computeExpiration(tokens.expires_in);
  return {
    ...tokens,
    expiresAt,
    profile,
    orgId: profile.orgId
  };
}

// src/auth/refresh-singleton.ts
function createRefreshGuard(refreshFn) {
  let inflight = null;
  return {
    refresh() {
      if (inflight) return inflight;
      inflight = refreshFn().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    isInflight() {
      return inflight !== null;
    }
  };
}

// src/auth/browser-redirect.ts
var VERIFIER_KEY_PREFIX = "bb_pkce_verifier:";
async function beginBrowserLogin(opts) {
  const clientId = opts.clientId;
  const scopes = opts.scopes ?? AUTH_SCOPES;
  const authorizeEndpoint = opts.authorizeEndpoint ?? AUTHORIZE_ENDPOINT;
  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  const state = generateStateNonce();
  sessionStorage.setItem(`${VERIFIER_KEY_PREFIX}${state}`, verifier);
  const url = new URL(authorizeEndpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", [...scopes].join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  window.location.href = url.toString();
  return new Promise(() => {
  });
}
async function completeBrowserLogin(opts) {
  const clientId = opts.clientId;
  const tokenEndpoint = opts.tokenEndpoint ?? TOKEN_ENDPOINT;
  const params = new URLSearchParams(window.location.search);
  const oauthError = params.get("error");
  if (oauthError) {
    const desc = params.get("error_description");
    throw new Error(
      `OAuth error: ${oauthError}${desc ? ` \u2014 ${desc}` : ""}`
    );
  }
  const code = params.get("code");
  if (!code) {
    return {
      isCallback: false,
      access_token: "",
      id_token: "",
      expires_in: 0,
      expiresAt: 0,
      profile: { sub: "", orgId: null },
      orgId: null
    };
  }
  const returnedState = params.get("state");
  if (!returnedState) {
    throw new Error("Missing OAuth state in callback \u2014 possible CSRF.");
  }
  const verifierKey = `${VERIFIER_KEY_PREFIX}${returnedState}`;
  const verifier = sessionStorage.getItem(verifierKey);
  if (!verifier) {
    throw new Error(
      "No stored PKCE verifier for state nonce \u2014 user may have refreshed mid-auth or possible CSRF."
    );
  }
  sessionStorage.removeItem(verifierKey);
  try {
    const tokens = await exchangeCode(
      code,
      verifier,
      opts.redirectUri,
      clientId,
      tokenEndpoint
    );
    const profile = extractProfile(tokens.id_token, tokens.access_token);
    const expiresAt = computeExpiration(tokens.expires_in);
    window.history.replaceState({}, document.title, window.location.pathname);
    return { isCallback: true, ...tokens, expiresAt, profile, orgId: profile.orgId };
  } catch (err) {
    throw err;
  }
}

export {
  generateVerifier,
  generateStateNonce,
  generateChallenge,
  encodePKCEState,
  decodePKCEState,
  decodeJwtPayload,
  extractOrgIdFromClaims,
  extractProfile,
  login,
  createRefreshGuard,
  beginBrowserLogin,
  completeBrowserLogin
};
//# sourceMappingURL=chunk-7CBPSUA7.js.map