import type { IdentityAdapter } from "../adapters/identity.js";
import { identifyUser, setAnalyticsGroup, trackEvent } from "../analytics/index.js";
import { AUTH_SCOPES, AUTHORIZE_ENDPOINT, TOKEN_ENDPOINT } from "../config.js";
import type { Profile } from "./jwt.js";
import { extractProfile } from "./jwt.js";
import { generateChallenge, generateStateNonce, generateVerifier } from "./pkce.js";
import type { TokenResult } from "./tokens.js";
import { computeExpiration, exchangeCode } from "./tokens.js";

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
  authorizeEndpoint?: string;
  tokenEndpoint?: string;
}

/** Zitadel's organization scope prefix — see {@link LoginOptions.orgId}. */
const ORG_SCOPE_PREFIX = "urn:zitadel:iam:org:id:";

/**
 * Append the Zitadel org scope, if an org was requested.
 *
 * Additive and idempotent: a caller that already put the scope in `scopes` does
 * not get it twice, and an absent or blank `orgId` leaves the list untouched
 * rather than emitting a malformed `urn:zitadel:iam:org:id:` with no value.
 */
function withOrgScope(scopes: readonly string[], orgId: string | undefined): readonly string[] {
  const trimmed = orgId?.trim();
  if (!trimmed) return scopes;
  const orgScope = `${ORG_SCOPE_PREFIX}${trimmed}`;
  return scopes.includes(orgScope) ? scopes : [...scopes, orgScope];
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
  trackEvent("auth_started", { mode: "oauth" });
  // Coarse failure phase for telemetry only — never carries error detail (no PII/secrets).
  let stage: "launch" | "parse" | "exchange" = "launch";
  try {
    const {
      clientId,
      scopes = AUTH_SCOPES,
      orgId: requestedOrgId,
      authorizeEndpoint = AUTHORIZE_ENDPOINT,
      tokenEndpoint = TOKEN_ENDPOINT,
    } = options;

    const redirectUri = identity.getRedirectUri();

    const verifier = generateVerifier();
    const challenge = await generateChallenge(verifier);
    // State is an independent CSRF nonce — the verifier MUST NOT travel in the URL.
    const state = generateStateNonce();

    const authUrl = new URL(authorizeEndpoint);
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", withOrgScope(scopes, requestedOrgId).join(" "));
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);

    const resultUrl = await identity.launchOAuthFlow(authUrl.toString());

    // A missing redirect URL is a launch-phase failure — only advance to "parse"
    // once we actually have a URL to parse.
    if (!resultUrl) throw new Error("No redirect URL returned from auth flow.");

    stage = "parse";
    const params = new URL(resultUrl).searchParams;
    const error = params.get("error");
    if (error) {
      throw new Error(`Auth error: ${error} — ${params.get("error_description") ?? ""}`);
    }

    const code = params.get("code");
    if (!code) throw new Error("No authorization code in redirect.");

    const returnedState = params.get("state");
    if (!returnedState) throw new Error("Missing state in redirect — possible CSRF.");

    // Verify the nonce round-trips intact (CSRF check).
    // The verifier is kept in local scope — it never appeared in the authorize URL.
    if (returnedState !== state) throw new Error("State mismatch — possible CSRF.");

    stage = "exchange";
    const tokens = await exchangeCode(code, verifier, redirectUri, clientId, tokenEndpoint);

    const profile = extractProfile(tokens.id_token, tokens.access_token);
    const expiresAt = computeExpiration(tokens.expires_in);

    // Bind identity BEFORE auth_success so every later event (message_send,
    // stream_*, api_error — none of which carry identity) is attributed to this
    // user + tenant, not to the anonymous device id. Both are guarded no-ops
    // when the adapter omits identify/group, as a multi-tenant server's does.
    if (profile.sub) identifyUser(profile.sub);
    if (profile.orgId) setAnalyticsGroup(profile.orgId);

    trackEvent(
      "auth_success",
      { mode: "oauth", latencyMs: Date.now() - startedAt },
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
    trackEvent("auth_failed", { mode: "oauth", stage });
    throw err;
  }
}
