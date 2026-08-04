/**
 * Crypto port (L7 host ports).
 *
 * The SDK reached `crypto.randomUUID`, `crypto.getRandomValues` and
 * `crypto.subtle.digest` on the global with no injection point. On React Native
 * that is a hard crash, not a degradation: Hermes has no Web Crypto, Expo's
 * runtime installs `TextDecoder`/`FormData`/`URL` but **not** crypto, and two of
 * the call sites are on the mainline send-message path.
 *
 * Shaped as a registry with a lazy default rather than a threaded parameter,
 * matching the analytics sink: the call sites are deep inside `pkce.ts`,
 * `messages.ts` and `agentic/client.ts`, and threading a parameter to each would
 * change several public signatures for a concern none of them own.
 */

/**
 * The three primitives the SDK actually needs.
 *
 * `digest` is pinned to SHA-256 rather than exposing SubtleCrypto, so a React
 * Native host can satisfy this with a small hash package instead of a full
 * WebCrypto polyfill. Widen it only when something needs a second algorithm.
 */
export interface CryptoAdapter {
  /** RFC 4122 v4 UUID. Used for idempotency keys and optimistic message ids. */
  randomUUID(): string;
  /** Fill `bytes` with CSPRNG output and return it. PKCE verifier + state nonce. */
  getRandomValues(bytes: Uint8Array): Uint8Array;
  /** SHA-256 of `data`. The PKCE S256 code challenge. */
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
}

/** Shape of the global this adapter wraps — structural, so no lib.dom dependency. */
interface WebCryptoLike {
  randomUUID?: () => string;
  getRandomValues: <T extends ArrayBufferView>(array: T) => T;
  subtle: { digest: (algorithm: string, data: Uint8Array) => Promise<ArrayBuffer> };
}

let registered: CryptoAdapter | null = null;

/**
 * Register the host's crypto implementation. Pass `null` to fall back to the
 * platform default.
 *
 * Process-wide, like the analytics adapter. That is acceptable here because the
 * implementation is stateless and identical for every tenant — unlike a
 * transport, where a shared singleton would leak one tenant's hosts into
 * another's requests.
 */
export function setCryptoAdapter(adapter: CryptoAdapter | null): void {
  registered = adapter;
}

/** Test seam: drop any registered adapter. */
export function resetCryptoAdapter(): void {
  registered = null;
}

/**
 * A {@link CryptoAdapter} over a Web Crypto implementation.
 *
 * The global is read through a parameter defaulting to `globalThis.crypto`, and
 * only when a method runs — never at import time, so importing this module stays
 * safe where crypto does not exist (invariant B). `randomUUID` is synthesised
 * from `getRandomValues` when absent, because Safari shipped the latter years
 * before the former.
 */
export function createWebCryptoAdapter(source?: WebCryptoLike): CryptoAdapter {
  const resolve = (): WebCryptoLike => {
    const c = source ?? (globalThis as { crypto?: WebCryptoLike }).crypto;
    if (!c) {
      throw new Error(
        "No Web Crypto available. Register a CryptoAdapter via setCryptoAdapter() — " +
          "React Native needs one (expo-crypto or react-native-get-random-values).",
      );
    }
    return c;
  };

  return {
    randomUUID: () => {
      const c = resolve();
      if (c.randomUUID) return c.randomUUID();
      return uuidV4From(c.getRandomValues(new Uint8Array(16)));
    },
    getRandomValues: bytes => resolve().getRandomValues(bytes),
    digest: (algorithm, data) => resolve().subtle.digest(algorithm, data),
  };
}

/** RFC 4122 v4 from 16 random bytes, for hosts whose crypto lacks `randomUUID`. */
function uuidV4From(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes);
  // Version 4 and the RFC 4122 variant bits.
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const platformDefault = createWebCryptoAdapter();

/**
 * The active adapter: whatever was registered, else the platform default.
 *
 * Resolved per call rather than cached, so a host that registers late — after a
 * module holding a reference was imported — still takes effect.
 */
export function getCryptoAdapter(): CryptoAdapter {
  return registered ?? platformDefault;
}
