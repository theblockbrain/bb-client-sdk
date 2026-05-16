import {
  computeExpiration,
  exchangeCode
} from "./chunk-EBZFVPXU.js";
import {
  AUTHORIZE_ENDPOINT,
  AUTH_CLIENT_ID,
  AUTH_SCOPES,
  TOKEN_ENDPOINT
} from "./chunk-OPBRY7NV.js";

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
async function login(identity, options = {}) {
  const {
    clientId = AUTH_CLIENT_ID,
    scopes = AUTH_SCOPES,
    authorizeEndpoint = AUTHORIZE_ENDPOINT,
    tokenEndpoint = TOKEN_ENDPOINT
  } = options;
  const redirectUri = identity.getRedirectUri();
  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  const state = encodePKCEState({ verifier });
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
  const decoded = decodePKCEState(returnedState);
  if (decoded.verifier !== verifier) throw new Error("State mismatch \u2014 possible CSRF.");
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

export {
  generateVerifier,
  generateChallenge,
  encodePKCEState,
  decodePKCEState,
  decodeJwtPayload,
  extractOrgIdFromClaims,
  extractProfile,
  login,
  createRefreshGuard
};
//# sourceMappingURL=chunk-7UTBFNGN.js.map