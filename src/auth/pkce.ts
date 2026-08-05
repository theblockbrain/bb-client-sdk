/**
 * PKCE helpers — RFC 7636 compliant.
 *
 * Randomness and hashing go through the {@link CryptoAdapter} port rather than the
 * `crypto` global, so a runtime without Web Crypto (React Native / Hermes) can
 * supply its own. The default resolves the global lazily, so behaviour in a
 * browser is unchanged.
 */
import { getCryptoAdapter } from "../adapters/crypto.js";

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
  getCryptoAdapter().getRandomValues(bytes);
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
  getCryptoAdapter().getRandomValues(bytes);
  return base64urlEncode(bytes.buffer);
}

/** Derive the PKCE code challenge (S256) from the verifier. */
export async function generateChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await getCryptoAdapter().digest("SHA-256", encoded);
  return base64urlEncode(digest);
}

/*
 * REMOVED in 0.18.0 (PDEV-7684): `encodePKCEState` / `decodePKCEState`.
 *
 * They base64'd `{verifier}` into the OAuth `state` parameter, which puts the
 * code verifier in the authorize URL — and therefore in browser history, the
 * Referer header, and IdP access logs. That is CWE-200, and it defeats the
 * single thing PKCE exists to do: make an intercepted authorization code
 * useless without the verifier.
 *
 * The replacement is already here and is what the SDK's own flows use:
 * `generateStateNonce()` for an independent CSRF nonce, with the verifier held
 * out of band — local scope in `login()`, or `sessionStorage` keyed by the
 * nonce in `browser-redirect.ts`. `src/auth/pkce.test.ts` pins that the
 * verifier never reaches the URL.
 *
 * Deliberately deleted rather than left `@deprecated`: a deprecation notice on
 * a security defect only works if someone reads it, and it had been sitting
 * unread long enough for a live surface to build on it.
 */
