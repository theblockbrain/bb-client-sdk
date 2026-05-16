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

/** Derive the PKCE code challenge (S256) from the verifier. */
export async function generateChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return base64urlEncode(digest);
}

interface PKCEState {
  verifier: string;
}

/** Encode PKCE state as base64url JSON for the OAuth state parameter. */
export function encodePKCEState(state: PKCEState): string {
  const json = JSON.stringify(state);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Decode PKCE state from the OAuth state parameter. Throws on malformed input. */
export function decodePKCEState(encoded: string): PKCEState {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(base64);
  return JSON.parse(json) as PKCEState;
}
