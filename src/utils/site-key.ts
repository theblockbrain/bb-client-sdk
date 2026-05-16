/**
 * Derive a stable, query-param-free key from a URL.
 * e.g. "news.ycombinator.com/news" (lowercase hostname, no trailing slash, no query/hash).
 * Falls back to the raw string on parse error.
 */
export function siteKey(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase() + u.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}
