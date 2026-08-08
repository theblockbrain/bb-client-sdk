import type { SyncStorageAdapter } from "../adapters/storage.js";
import { createWebStorageAdapter } from "../adapters/web-storage.js";
import { AUTH_SCOPES, AUTHORIZE_ENDPOINT, TOKEN_ENDPOINT } from "../config.js";
import { extractProfile } from "./jwt-claims.js";
import type { LoginResult } from "./login.js";
import { withOrgScope } from "./org-scope.js";
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
  /**
   * **REPLACES** {@link AUTH_SCOPES} entirely, it does not extend it. Same
   * contract as `LoginOptions.scopes`, and the same trap: pass a partial list and
   * you silently drop the rest, so without `offline_access` there is no refresh
   * token and the session dies at the first expiry. To add a scope, spread the
   * default (`scopes: [...AUTH_SCOPES, "my:scope"]`). To pin the login to an
   * organization use {@link BrowserRedirectOptions.orgId}, never a hand-built URN.
   *
   * Default: {@link AUTH_SCOPES} from config.
   */
  scopes?: readonly string[];
  /**
   * Pin the login to a specific Zitadel organization.
   *
   * Appended as `urn:zitadel:iam:org:id:<orgId>` **on top of** whatever `scopes`
   * are in effect, so it cannot accidentally displace `offline_access`. Same
   * option, same helper, and same semantics as `LoginOptions.orgId`, because a
   * surface that offers the dialog flow with a browser fallback must not have to
   * express the tenant differently on each path.
   *
   * Two models exist across our surfaces and both are legitimate:
   *
   * - **Org as output (omit this).** The user signs in, Zitadel resolves their
   *   home org, and `extractProfile` reads it from the token claims. This is what
   *   `ms-outlook-addin` does: it never asks which tenant you are.
   * - **Org as input (set this).** The tenant is known up front, from a URL
   *   parameter, a deep link, or a form, and the login is pinned to it. This is
   *   what `ms-word-addin` does with its `?orgId=` parameter.
   *
   * Pinning changes which org the user is authenticated *into*, so it is a
   * tenant-routing decision: pass the tenant the user chose, never a value
   * inferred from someone else's context.
   *
   * **Read by {@link beginBrowserLogin} only.** The org is decided at the
   * authorize step, so `completeBrowserLogin` ignores this field: see the note on
   * that function. Passing it there and not here reads as if the login were
   * pinned when it is not, which is the PDEV-7369 defect in a different shape.
   */
  orgId?: string;
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
 *
 * This is where the organization is decided, via
 * {@link BrowserRedirectOptions.orgId}. Omit it and Zitadel resolves the user's
 * home org (org as output). Set it and the login is pinned (org as input).
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
  // Through the SAME helper `login()` uses, not a local re-implementation. The two
  // paths are one tenant-routing rule with two entry points (PDEV-7369).
  url.searchParams.set("scope", withOrgScope(scopes, opts.orgId).join(" "));
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
 *
 * **Deliberately ignores {@link BrowserRedirectOptions.orgId}.** It shares the
 * options interface with {@link beginBrowserLogin}, so the field is accepted here,
 * but there is nowhere for it to go and no effect it could have:
 *
 * - The authorization-code token request carries no `scope` (RFC 6749 §4.1.3). The
 *   granted scope was fixed at the authorize step and the issued token inherits
 *   it, which is why `exchangeCode` has no scope parameter and why `refreshTokens`
 *   omits scope too (Zitadel rejects custom scopes on a token request).
 * - The code itself is already bound to the org context Zitadel resolved during
 *   the authorize hop, so re-stating the org at exchange time could not move it.
 *
 * Consequence worth knowing, because the two calls usually live in different
 * files (begin behind a sign-in button, complete in app bootstrap): passing
 * `orgId` **only** here pins nothing at all and logs the user into their default
 * organization, with no error anywhere. Pass it to `beginBrowserLogin`.
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
