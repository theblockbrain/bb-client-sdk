/**
 * Strip markdown code fences from LLM output.
 * Returns the raw string unchanged if no fence is found.
 */
declare function extractCode(text: string): string;

/**
 * createLock — factory that serialises async operations through a promise queue.
 *
 * Useful when concurrent writes to a non-atomic store (e.g. chrome.storage.local)
 * would cause last-write-wins data loss. All mutations go through withLock so each
 * sees the result of the previous one.
 */
declare function createLock(): {
    withLock<T>(fn: () => Promise<T>): Promise<T>;
};

/**
 * Robustly extract a JSON value from an LLM response.
 * Handles markdown code fences, partial responses, and unescaped quotes
 * inside string values (a common LLM failure mode).
 *
 * Returns the parsed value, or null if no valid JSON could be recovered.
 * Does NOT throw — callers should handle null explicitly.
 */
declare function extractJson<T = unknown>(text: string): T | null;
/**
 * Best-effort repair of unescaped quote characters within JSON string values.
 *
 * Walks character-by-character tracking string context, and escapes any quote
 * that is not followed by a structural JSON character (`,` `}` `]` `:`).
 * Handles backslash escape sequences correctly so already-escaped quotes are
 * not double-escaped.
 *
 * Not 100% for pathological inputs — covers the most common LLM-emitted
 * JSON-quote-escape failures.
 */
declare function repairUnescapedQuotes(str: string): string;

/**
 * Minimal JWT payload reader — no signature verification.
 *
 * We only need to read the `sub` claim from Zitadel access tokens so the SDK
 * can auto-fill `resourceId` for Agentic calls without requiring callers to
 * thread a userId through their auth wiring.
 *
 * Signature verification is intentionally OMITTED here: the backend verifies
 * the token on every request. Reading the sub client-side is safe because we
 * never make trust decisions based on it — it is sent to the server as a
 * `resourceId` hint that the server can cross-check against the verified JWT.
 */
/**
 * Extract the `sub` claim from a Zitadel access-token JWT.
 *
 * Returns the sub string when the token is a valid JWT with a non-empty sub
 * claim. Returns `null` for:
 * - Non-JWT tokens (API keys, opaque tokens)
 * - JWTs without a `sub` claim
 * - Malformed input
 *
 * Returns `null` for non-JWT tokens such as `sk-` API keys, so callers need
 * not gate on `mode === "oauth"` — the shape-check handles it gracefully.
 */
declare function subFromAccessToken(token: string): string | null;

export { createLock, extractCode, extractJson, repairUnescapedQuotes, subFromAccessToken };
