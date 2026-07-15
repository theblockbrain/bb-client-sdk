import type { IdentityAdapter } from "../adapters/identity.js";
import { trackEvent } from "../analytics/index.js";
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
  scopes?: readonly string[];
  authorizeEndpoint?: string;
  tokenEndpoint?: string;
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
  let stage = "launch";
  try {
    const {
      clientId,
      scopes = AUTH_SCOPES,
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
    authUrl.searchParams.set("scope", [...scopes].join(" "));
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);

    const resultUrl = await identity.launchOAuthFlow(authUrl.toString());

    stage = "parse";
    if (!resultUrl) throw new Error("No redirect URL returned from auth flow.");

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
