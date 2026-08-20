import type { IdentityAdapter } from "../adapters/identity.js";
import { identifyUser, setAnalyticsGroup, trackEvent } from "../analytics/index.js";
import { AUTH_SCOPES, AUTHORIZE_ENDPOINT, TOKEN_ENDPOINT } from "../config.js";
import type { SignInMethod, SignInStage } from "../telemetry/taxonomy.js";
import type { Profile } from "./jwt-claims.js";
import { decodeJwtPayload, extractProfile } from "./jwt-claims.js";
import { readOAuthError } from "./oauth-error.js";
// Shared with `beginBrowserLogin`. Two copies of a tenant-routing rule is a
// cross-tenant isolation bug waiting for the next divergent edit, so both PKCE
// entry points append the org scope through this one function.
import { withOrgScope } from "./org-scope.js";
import { generateChallenge, generateStateNonce, generateVerifier } from "./pkce.js";
import type { TokenResult } from "./tokens.js";
import { computeExpiration, exchangeCode } from "./tokens.js";

/**
 * How this module signs a user in, in the taxonomy's closed vocabulary.
 *
 * Hoisted so the three `sign_in_*` events cannot drift apart: a funnel whose
 * `started` and `completed` legs disagree on `method` silently reports 0%.
 */
const SIGN_IN_METHOD: SignInMethod = "oidc";

export interface LoginResult extends TokenResult {
  /** Unix timestamp (ms) when access_token expires. */
  expiresAt: number;
  profile: Profile;
  orgId: string | null;
}

export interface LoginOptions {
  /** OAuth client_id — must be provided by the caller; no SDK-level default. */
  clientId: string;
  /**
   * **REPLACES** {@link AUTH_SCOPES} entirely — it does not extend it.
   *
   * Pass a partial list and you silently drop the rest: without `offline_access`
   * there is no refresh token, so the session dies at the first expiry and the
   * user is bounced back to sign-in with no obvious cause. To add a scope, spread
   * the default: `scopes: [...AUTH_SCOPES, "my:scope"]`. To pin the login to an
   * organization, use {@link LoginOptions.orgId} rather than hand-building the URN.
   */
  scopes?: readonly string[];
  /**
   * Pin the login to a specific Zitadel organization.
   *
   * Appended as `urn:zitadel:iam:org:id:<orgId>` **on top of** whatever `scopes`
   * are in effect, so it cannot accidentally displace `offline_access`.
   *
   * Two models exist across our surfaces and both are legitimate — this option is
   * what makes the choice explicit rather than a hand-concatenated string:
   *
   * - **Org as output (omit this).** The user signs in, Zitadel resolves their
   *   home org, and `extractProfile` reads it from the token claims. This is what
   *   `ms-outlook-addin` does: it never asks which tenant you are.
   * - **Org as input (set this).** The tenant is known up front — from a URL
   *   parameter, a deep link, or a form — and the login is pinned to it. This is
   *   what `ms-word-addin` does with its `?orgId=` parameter.
   *
   * Pinning changes which org the user is authenticated *into*, so it is a
   * tenant-routing decision: pass the tenant the user chose, never a value
   * inferred from someone else's context.
   */
  orgId?: string;
  /**
   * The address the user already typed, forwarded as OIDC `login_hint`.
   *
   * The point of the email-first flow is that the address is collected once. Without
   * this the tenant resolve stays hidden but the login page still opens with an
   * empty field, so the user types it again immediately after we told them we knew
   * who they were.
   *
   * A hint, not an assertion: the provider may ignore it, and the user can always
   * sign in as somebody else.
   */
  loginHint?: string;
  /**
   * Fail the login when the ID token carries no `nonce` claim.
   *
   * A MISMATCH always fails, with or without this: the token was minted for a
   * different authorize request, which is exactly the substitution the nonce exists
   * to catch. This flag governs only the ABSENT case.
   *
   * Default `false`, and that is a deliberate trade-off rather than a preference.
   * OIDC Core requires a provider to echo the nonce it was sent, but that has not
   * been exercised against our deployed Zitadel, and defaulting to strict would
   * convert an unverified assumption into a total sign-in outage across every
   * surface at once. Turn it on per surface once the provider is confirmed to echo
   * it, then make it the default.
   */
  requireNonce?: boolean;
  /**
   * OIDC `prompt`. Pass `"login"` to make the provider re-authenticate instead of
   * completing silently against its existing web session.
   *
   * Needed wherever a device is shared. {@link LoginOptions.loginHint} is only a
   * hint, so with a live provider session the authorize call can return as whoever
   * signed in last, and the second person at a shared workstation lands in the
   * first person's account. Send it when the address differs from the one that
   * signed in last, and omit it otherwise so a returning user keeps the instant
   * path.
   *
   * Not `"select_account"`: an account chooser defeats the pre-filled address.
   */
  prompt?: "login" | "consent" | "select_account" | "none";
  authorizeEndpoint?: string;
  tokenEndpoint?: string;
}

/**
 * Check the ID token was minted for the request we started.
 *
 * Throws on a mismatch always, and on an absent claim only under `requireNonce` —
 * see {@link LoginOptions.requireNonce} for why those two differ.
 *
 * The nonce values are NOT included in the message. They are single-use and not
 * secret, but the message is the one part of an error that reliably reaches a log
 * or a UI label, and a bare "did not match" is enough to act on.
 */
function assertNonce(idToken: string, expected: string, required: boolean): void {
  const claims = decodeJwtPayload(idToken);
  const actual = claims?.nonce;

  if (actual === undefined || actual === null || actual === "") {
    if (required) {
      throw new Error("ID token carries no nonce claim, and this client requires one.");
    }
    return;
  }

  if (actual !== expected) {
    throw new Error("ID token nonce did not match the authorize request.");
  }
}

/**
 * Run the full PKCE login flow using the provided IdentityAdapter.
 *
 * 1. Generate PKCE verifier + challenge.
 * 2. Build Zitadel authorize URL.
 * 3. Delegate browser flow to `identity.launchOAuthFlow(url)` — returns redirect URL with ?code=.
 * 4. Extract code + verify state.
 * 5. Exchange code for tokens.
 * 6. Extract profile + orgId from id_token (access_token as fallback).
 */
export async function login(
  identity: IdentityAdapter,
  options: LoginOptions,
): Promise<LoginResult> {
  const startedAt = Date.now();
  // `oidc`, not `oauth`: `method` is the taxonomy's closed {@link SignInMethod}
  // vocabulary (password | sso | oidc | api_key), and this function is the
  // OIDC/PKCE authorization-code path specifically.
  trackEvent("sign_in_started", { method: SIGN_IN_METHOD });
  // Coarse failure phase for telemetry only — never carries error detail (no PII/secrets).
  let stage: SignInStage = "launch";
  try {
    const {
      clientId,
      scopes = AUTH_SCOPES,
      orgId: requestedOrgId,
      loginHint,
      requireNonce = false,
      prompt,
      authorizeEndpoint = AUTHORIZE_ENDPOINT,
      tokenEndpoint = TOKEN_ENDPOINT,
    } = options;

    const redirectUri = identity.getRedirectUri();

    const verifier = generateVerifier();
    const challenge = await generateChallenge(verifier);
    // State is an independent CSRF nonce — the verifier MUST NOT travel in the URL.
    const state = generateStateNonce();
    // A SEPARATE value from `state`, and separate on purpose. `state` protects the
    // redirect (CSRF); `nonce` binds the returned ID token to this request (OIDC
    // Core 3.1.2.1). Deriving one from the other would let a holder of either
    // predict the other. Verified against the token's claim below.
    const nonce = generateStateNonce();

    const authUrl = new URL(authorizeEndpoint);
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", withOrgScope(scopes, requestedOrgId).join(" "));
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("nonce", nonce);
    // Blank is treated as absent: an empty form field must not become
    // `login_hint=`, which some providers surface as a failed lookup rather than
    // as no hint at all.
    if (loginHint?.trim()) authUrl.searchParams.set("login_hint", loginHint.trim());
    if (prompt) authUrl.searchParams.set("prompt", prompt);

    const resultUrl = await identity.launchOAuthFlow(authUrl.toString());

    // A missing redirect URL is a launch-phase failure — only advance to "parse"
    // once we actually have a URL to parse.
    if (!resultUrl) throw new Error("No redirect URL returned from auth flow.");

    stage = "parse";
    const params = new URL(resultUrl).searchParams;
    // Typed, so a consumer can tell a declined consent screen (`access_denied`,
    // not a bug) from a misconfigured client without matching on message text.
    // This used to throw a plain Error whose message ended in a bare separator
    // when the provider sent no description, and that message reached at least one
    // consumer's UI as a label.
    const failure = readOAuthError(params);
    if (failure) throw failure;

    const code = params.get("code");
    if (!code) throw new Error("No authorization code in redirect.");

    const returnedState = params.get("state");
    if (!returnedState) throw new Error("Missing state in redirect — possible CSRF.");

    // Verify the nonce round-trips intact (CSRF check).
    // The verifier is kept in local scope — it never appeared in the authorize URL.
    if (returnedState !== state) throw new Error("State mismatch — possible CSRF.");

    stage = "exchange";
    const tokens = await exchangeCode(code, verifier, redirectUri, clientId, tokenEndpoint);

    assertNonce(tokens.id_token, nonce, requireNonce);

    const profile = extractProfile(tokens.id_token, tokens.access_token);
    const expiresAt = computeExpiration(tokens.expires_in);

    // Bind identity BEFORE sign_in_completed so every later event (message_sent,
    // stream_*, api_error — none of which carry identity) is attributed to this
    // user + tenant, not to the anonymous device id. Both are guarded no-ops
    // when the adapter omits identify/group, as a multi-tenant server's does.
    if (profile.sub) identifyUser(profile.sub);
    if (profile.orgId) setAnalyticsGroup(profile.orgId);

    trackEvent(
      "sign_in_completed",
      { method: SIGN_IN_METHOD, latency_ms: Date.now() - startedAt },
      { distinctId: profile.sub, orgId: profile.orgId ?? undefined },
    );

    return {
      ...tokens,
      expiresAt,
      profile,
      orgId: profile.orgId,
    };
  } catch (err) {
    // Fire-and-forget health signal; the original error is re-thrown unchanged.
    trackEvent("sign_in_failed", { method: SIGN_IN_METHOD, stage });
    throw err;
  }
}
