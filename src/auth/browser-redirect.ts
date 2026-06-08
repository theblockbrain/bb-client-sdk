import {
  generateVerifier,
  generateChallenge,
  encodePKCEState,
  decodePKCEState,
} from "./pkce.js";
import { exchangeCode, computeExpiration } from "./tokens.js";
import { extractProfile } from "./jwt.js";
import {
  AUTH_SCOPES,
  AUTHORIZE_ENDPOINT,
  TOKEN_ENDPOINT,
} from "../config.js";
import type { LoginResult } from "./login.js";

const STATE_KEY = "bb_pkce_state";

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
export async function beginBrowserLogin(
  opts: BrowserRedirectOptions,
): Promise<never> {
  const clientId = opts.clientId;
  const scopes = opts.scopes ?? AUTH_SCOPES;
  const authorizeEndpoint = opts.authorizeEndpoint ?? AUTHORIZE_ENDPOINT;

  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  const state = encodePKCEState({ verifier });

  sessionStorage.setItem(STATE_KEY, state);

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
    sessionStorage.removeItem(STATE_KEY);
    const desc = params.get("error_description");
    throw new Error(
      `OAuth error: ${oauthError}${desc ? ` — ${desc}` : ""}`,
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
      orgId: null,
    };
  }

  const returnedState = params.get("state");
  if (!returnedState) {
    sessionStorage.removeItem(STATE_KEY);
    throw new Error("Missing OAuth state in callback — possible CSRF.");
  }

  const storedState = sessionStorage.getItem(STATE_KEY);
  if (!storedState) {
    throw new Error(
      "No stored PKCE state — user may have refreshed mid-auth.",
    );
  }
  if (storedState !== returnedState) {
    sessionStorage.removeItem(STATE_KEY);
    throw new Error("OAuth state mismatch — possible CSRF.");
  }

  const { verifier } = decodePKCEState(returnedState);

  try {
    const tokens = await exchangeCode(
      code,
      verifier,
      opts.redirectUri,
      clientId,
      tokenEndpoint,
    );
    const profile = extractProfile(tokens.id_token, tokens.access_token);
    const expiresAt = computeExpiration(tokens.expires_in);

    sessionStorage.removeItem(STATE_KEY);
    window.history.replaceState({}, document.title, window.location.pathname);

    return { isCallback: true, ...tokens, expiresAt, profile, orgId: profile.orgId };
  } catch (err) {
    sessionStorage.removeItem(STATE_KEY);
    throw err;
  }
}
