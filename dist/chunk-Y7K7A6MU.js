import {
  TOKEN_ENDPOINT
} from "./chunk-TGCXGCQH.js";

// src/auth/tokens.ts
async function exchangeCode(code, verifier, redirectUri, clientId, tokenEndpoint = TOKEN_ENDPOINT) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier
  });
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.status.toString());
    throw new Error(`Token exchange failed: ${text}`);
  }
  return await res.json();
}
async function refreshTokens(refreshToken, clientId, tokenEndpoint = TOKEN_ENDPOINT) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken
  });
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[auth] refreshTokens failed:", res.status, text);
    throw new Error(`Token refresh failed: ${res.status}`);
  }
  return await res.json();
}
function computeExpiration(expiresInSeconds) {
  return Date.now() + expiresInSeconds * 1e3;
}
function isTokenExpired(expirationMs, leadMs = 6e4) {
  if (!expirationMs) return true;
  return expirationMs - Date.now() < leadMs;
}

export {
  exchangeCode,
  refreshTokens,
  computeExpiration,
  isTokenExpired
};
//# sourceMappingURL=chunk-Y7K7A6MU.js.map