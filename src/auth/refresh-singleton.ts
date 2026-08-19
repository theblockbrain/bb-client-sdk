/**
 * createRefreshGuard — factory that prevents parallel token refresh calls.
 *
 * When multiple API calls race and all find an expired token, only one refresh
 * request is made. All callers share the same in-flight promise.
 *
 * The single-flight property is also what makes this the right place to emit the
 * refresh telemetry: the events fire once per REAL refresh, not once per waiter,
 * so `session_token_refreshed` counts refreshes rather than contention. Emitting
 * from the call sites instead would make a refresh storm — the thing the SLO
 * watches for — look identical to normal traffic.
 */

import { telemetryErrorCode } from "../analytics/error-code.js";
import { trackEvent } from "../analytics/index.js";

export function createRefreshGuard<T>(refreshFn: () => Promise<T>): {
  refresh(): Promise<T>;
  isInflight(): boolean;
} {
  let inflight: Promise<T> | null = null;

  return {
    refresh(): Promise<T> {
      if (inflight) return inflight;
      const startedAt = Date.now();
      inflight = refreshFn()
        .then(
          result => {
            trackEvent("session_token_refreshed", { latency_ms: Date.now() - startedAt });
            return result;
          },
          (error: unknown) => {
            // `telemetryErrorCode`, not the status alone: `401` (the grant is gone —
            // re-auth) and `503` (the IdP is unreachable — retry) demand opposite
            // responses, and so does a `network`/`timeout` failure that never got a
            // status at all. Coding from `statusCode` alone files all three of those
            // as "0", which is one bucket for three different remedies. The message
            // and body are never read: they can echo a submitted token.
            trackEvent("session_token_refresh_failed", { error_code: telemetryErrorCode(error) });
            // Re-thrown unchanged — telemetry observes the failure, it does not
            // absorb it.
            throw error;
          },
        )
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    isInflight(): boolean {
      return inflight !== null;
    },
  };
}
