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

export { createLock, extractCode, siteKey };
