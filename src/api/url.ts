/** Strip trailing slashes to avoid double-slash in URL paths. */
export function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
