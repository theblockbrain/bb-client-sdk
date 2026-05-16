import { I as IdentityAdapter } from '../identity-DyKDSltP.js';

/**
 * PKCE helpers — RFC 7636 compliant.
 * No platform dependencies — uses Web Crypto API (available in all modern browsers + SW).
 */
/**
 * Generate a cryptographically random PKCE code verifier.
 * 32 random bytes → 43-char base64url string (RFC 7636 compliant).
 * NOT crypto.randomUUID() — that produces 36 chars with hyphens, which is non-compliant.
 */
declare function generateVerifier(): string;
/** Derive the PKCE code challenge (S256) from the verifier. */
declare function generateChallenge(verifier: string): Promise<string>;
interface PKCEState {
    verifier: string;
}
/** Encode PKCE state as base64url JSON for the OAuth state parameter. */
declare function encodePKCEState(state: PKCEState): string;
/** Decode PKCE state from the OAuth state parameter. Throws on malformed input. */
declare function decodePKCEState(encoded: string): PKCEState;

/**
 * Client-side JWT utilities — no signature verification (server validates).
 * Avoids the `jose` dependency by implementing the minimal decode needed.
 */
interface Profile {
    sub: string;
    email?: string;
    name?: string;
    given_name?: string;
    family_name?: string;
    orgId: string | null;
}
/**
 * Decode a JWT payload without verifying the signature.
 * Returns null on malformed input so callers can handle gracefully.
 */
declare function decodeJwtPayload(token: string): Record<string, unknown> | null;
/**
 * Try to extract an orgId from decoded JWT claims.
 *
 * Zitadel may place the org id in any of three locations depending on
 * which scopes were requested and how the project is configured:
 *
 *   1. `urn:zitadel:iam:org:id`                — direct string (org-scoped login)
 *   2. `urn:zitadel:iam:user:resourceowner:id` — direct string ("User Info in ID Token" enabled)
 *   3. `urn:zitadel:iam:org:project:roles`     — object whose first role value has the
 *      orgId as its first key (project roles requested)
 *
 * Returns the first non-empty value found, or null.
 */
declare function extractOrgIdFromClaims(claims: Record<string, unknown>): string | null;
/**
 * Decode the ID token and extract the user profile.
 *
 * When `accessToken` is provided, it is used as a fallback source for orgId in case
 * Zitadel did not embed it in the id_token. Access tokens may be opaque (reference tokens)
 * depending on the Zitadel project config, so the fallback decode is wrapped in try/catch.
 */
declare function extractProfile(idToken: string, accessToken?: string): Profile;

interface TokenResult {
    access_token: string;
    refresh_token?: string;
    id_token: string;
    expires_in: number;
}
/**
 * Exchange an authorization code for tokens (PKCE authorization_code grant).
 *
 * @param code        Authorization code from the redirect callback.
 * @param verifier    PKCE code verifier generated before the authorize redirect.
 * @param redirectUri Must match the URI registered in Zitadel and used in the authorize URL.
 * @param clientId    Defaults to AUTH_CLIENT_ID.
 * @param tokenEndpoint Defaults to TOKEN_ENDPOINT.
 */
declare function exchangeCode(code: string, verifier: string, redirectUri: string, clientId?: string, tokenEndpoint?: string): Promise<TokenResult>;
/**
 * Refresh the access token using the refresh_token grant.
 *
 * @param refreshToken  Stored refresh token.
 * @param clientId      Defaults to AUTH_CLIENT_ID.
 * @param tokenEndpoint Defaults to TOKEN_ENDPOINT.
 * @param scopes        Defaults to AUTH_SCOPES.
 */
declare function refreshTokens(refreshToken: string, clientId?: string, tokenEndpoint?: string, scopes?: readonly string[]): Promise<TokenResult>;
/** Compute the expiration timestamp (ms) from an expires_in value (seconds). */
declare function computeExpiration(expiresInSeconds: number): number;
/** True when the token expires within the given lead time (default: 60 seconds). */
declare function isTokenExpired(expirationMs: number | null, leadMs?: number): boolean;

interface LoginResult extends TokenResult {
    /** Unix timestamp (ms) when access_token expires. */
    expiresAt: number;
    profile: Profile;
    orgId: string | null;
}
interface LoginOptions {
    clientId?: string;
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
declare function login(identity: IdentityAdapter, options?: LoginOptions): Promise<LoginResult>;

/**
 * createRefreshGuard — factory that prevents parallel token refresh calls.
 *
 * When multiple API calls race and all find an expired token, only one refresh
 * request is made. All callers share the same in-flight promise.
 */
declare function createRefreshGuard<T>(refreshFn: () => Promise<T>): {
    refresh(): Promise<T>;
    isInflight(): boolean;
};

export { type LoginOptions, type LoginResult, type Profile, type TokenResult, computeExpiration, createRefreshGuard, decodeJwtPayload, decodePKCEState, encodePKCEState, exchangeCode, extractOrgIdFromClaims, extractProfile, generateChallenge, generateVerifier, isTokenExpired, login, refreshTokens };
