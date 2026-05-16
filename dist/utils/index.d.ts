/**
 * Derive a stable, query-param-free key from a URL.
 * e.g. "news.ycombinator.com/news" (lowercase hostname, no trailing slash, no query/hash).
 * Falls back to the raw string on parse error.
 */
declare function siteKey(url: string): string;

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

export { createLock, extractCode, extractJson, repairUnescapedQuotes, siteKey };
