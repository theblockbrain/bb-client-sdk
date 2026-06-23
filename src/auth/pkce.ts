/**
 * PKCE helpers — RFC 7636 compliant.
 * No platform dependencies — uses Web Crypto API (available in all modern browsers + SW).
 */

function base64urlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (const byte of bytes) {
    str += String.fromCharCode(byte);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Generate a cryptographically random PKCE code verifier.
 * 32 random bytes → 43-char base64url string (RFC 7636 compliant).
 * NOT crypto.randomUUID() — that produces 36 chars with hyphens, which is non-compliant.
 */
export function generateVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes.buffer);
}

/**
 * Generate a cryptographically random CSRF state nonce.
 * 32 random bytes → 43-char base64url string — same entropy as the verifier,
 * but completely independent of it.
 *
 * This MUST be the value sent as the OAuth `state` parameter.
 * The `code_verifier` must NEVER appear in the authorize URL (CWE-200).
 */
export function generateStateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes.buffer);
}

/** Derive the PKCE code challenge (S256) from the verifier. */
export async function generateChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64urlEncode(digest);
}

/**
 * @deprecated The `state` parameter must NOT carry the `code_verifier` — doing so
 * leaks the verifier into browser history and IdP logs, defeating PKCE's
 * interception defence (CWE-200). Use `generateStateNonce()` for the state value
 * and store the verifier separately in sessionStorage keyed by that nonce.
 *
 * This export is kept for backwards compatibility with existing consumers.
 * Internal SDK code no longer calls it.
 */
export function encodePKCEState(state: { verifier: string }): string {
  const json = JSON.stringify(state);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * @deprecated Counterpart to the deprecated `encodePKCEState`. Kept for
 * backwards compatibility; internal SDK code no longer calls it.
 */
export function decodePKCEState(encoded: string): { verifier: string } {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(base64);
  return JSON.parse(json) as { verifier: string };
}
