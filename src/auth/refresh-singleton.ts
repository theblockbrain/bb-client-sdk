/**
 * createRefreshGuard — factory that prevents parallel token refresh calls.
 *
 * When multiple API calls race and all find an expired token, only one refresh
 * request is made. All callers share the same in-flight promise.
 */
export function createRefreshGuard<T>(refreshFn: () => Promise<T>): {
  refresh(): Promise<T>;
  isInflight(): boolean;
} {
  let inflight: Promise<T> | null = null;

  return {
    refresh(): Promise<T> {
      if (inflight) return inflight;
      inflight = refreshFn().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    isInflight(): boolean {
      return inflight !== null;
    },
  };
}
