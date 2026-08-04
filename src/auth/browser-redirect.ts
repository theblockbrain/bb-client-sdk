import type { SyncStorageAdapter } from "../adapters/storage.js";
import { createWebStorageAdapter } from "../adapters/web-storage.js";
import { AUTH_SCOPES, AUTHORIZE_ENDPOINT, TOKEN_ENDPOINT } from "../config.js";
import { extractProfile } from "./jwt-claims.js";
import type { LoginResult } from "./login.js";
import { generateChallenge, generateStateNonce, generateVerifier } from "./pkce.js";
import { computeExpiration, exchangeCode } from "./tokens.js";

/**
 * sessionStorage key prefix for the per-nonce verifier entry.
 * Key shape: `bb_pkce_verifier:<state-nonce>`
 *
 * Using a per-nonce key (rather than a single fixed key) means concurrent
 * tabs each get their own isolated entry and don't clobber each other.
 */
const VERIFIER_KEY_PREFIX = "bb_pkce_verifier:";

export interface BrowserRedirectOptions {
  /** OAuth client_id — must be provided by the caller; no SDK-level default. */
  clientId: string;
  /** Default: AUTH_SCOPES from config */
  scopes?: readonly string[];
  /** Default: AUTHORIZE_ENDPOINT from config */
  authorizeEndpoint?: string;
  /** Default: TOKEN_ENDPOINT from config */
  tokenEndpoint?: string;
  /** Redirect-URI registered in the Zitadel app */
  redirectUri: string;
  /**
   * Where the per-nonce PKCE verifier is held across the redirect. Defaults to
   * `sessionStorage`, which is correct for a browser tab: it is cleared when the
   * tab closes, and the verifier is single-use anyway.
   *
   * Injectable because this is the seam, not because another backing is expected
   * here — a host that partitions storage (an iframed embed, a strict-mode
   * browser blocking third-party `sessionStorage`) can supply its own.
   */
  storage?: SyncStorageAdapter;
}

/**
 * The verifier store for a call. Resolved per call, so `sessionStorage` is only
 * dereferenced when one of these browser-only functions actually runs — importing
 * this module stays safe where it does not exist.
 */
function verifierStore(opts: BrowserRedirectOptions): SyncStorageAdapter {
  return opts.storage ?? createWebStorageAdapter(sessionStorage);
}

export interface BrowserLoginResult extends LoginResult {
  /** True when called on the callback page with ?code=, false on a normal page load */
  isCallback: boolean;
}

/**
 * Starts a full-page-redirect OAuth login (PKCE, S256).
 *
 * Stores PKCE state in sessionStorage and navigates window.location to the
 * Zitadel authorize URL. Never returns — the page is unloaded.
 */
export async function beginBrowserLogin(opts: BrowserRedirectOptions): Promise<never> {
  const clientId = opts.clientId;
  const scopes = opts.scopes ?? AUTH_SCOPES;
  const authorizeEndpoint = opts.authorizeEndpoint ?? AUTHORIZE_ENDPOINT;

  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  // State is an independent CSRF nonce — the verifier MUST NOT travel in the URL.
  const state = generateStateNonce();

  // Store the verifier keyed by the nonce so completeBrowserLogin can recover it.
  verifierStore(opts).set(`${VERIFIER_KEY_PREFIX}${state}`, verifier);

  const url = new URL(authorizeEndpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", [...scopes].join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  window.location.href = url.toString();
  // Promise never resolves — page navigates away
  return new Promise<never>(() => {});
}

/**
 * Detects whether the current page load is an OAuth callback and, if so,
 * completes the PKCE flow.
 *
 * Call once at app initialisation (e.g. a top-level useEffect or main.ts).
 *
 * - No ?code= in URL → returns { isCallback: false, ...empty }
 * - ?error= in URL → throws with the OAuth error message
 * - State mismatch → throws (CSRF guard)
 * - Valid code + state → exchanges code, cleans URL, returns { isCallback: true, ... }
 *
 * The caller is responsible for persisting the returned tokens.
 */
export async function completeBrowserLogin(
  opts: BrowserRedirectOptions,
): Promise<BrowserLoginResult> {
  const clientId = opts.clientId;
  const tokenEndpoint = opts.tokenEndpoint ?? TOKEN_ENDPOINT;

  const params = new URLSearchParams(window.location.search);
  const oauthError = params.get("error");

  if (oauthError) {
    const desc = params.get("error_description");
    throw new Error(`OAuth error: ${oauthError}${desc ? ` — ${desc}` : ""}`);
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
      orgId: null,
    };
  }

  const returnedState = params.get("state");
  if (!returnedState) {
    throw new Error("Missing OAuth state in callback — possible CSRF.");
  }

  const verifierKey = `${VERIFIER_KEY_PREFIX}${returnedState}`;
  const store = verifierStore(opts);
  const verifier = store.get(verifierKey);
  if (!verifier) {
    // No entry for this nonce: either a CSRF attempt or the user refreshed mid-auth.
    throw new Error(
      "No stored PKCE verifier for state nonce — user may have refreshed mid-auth or possible CSRF.",
    );
  }

  // Clear eagerly so the verifier cannot be read again after this point.
  store.remove(verifierKey);
  const tokens = await exchangeCode(code, verifier, opts.redirectUri, clientId, tokenEndpoint);
  const profile = extractProfile(tokens.id_token, tokens.access_token);
  const expiresAt = computeExpiration(tokens.expires_in);

  window.history.replaceState({}, document.title, window.location.pathname);

  return { isCallback: true, ...tokens, expiresAt, profile, orgId: profile.orgId };
}
