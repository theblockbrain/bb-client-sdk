import { afterEach, describe, expect, it } from "vitest";

import type { AnalyticsAdapter } from "../analytics/index.js";
import { resetAnalyticsAdapter, setAnalyticsAdapter } from "../analytics/index.js";
import { BBApiError } from "../api/errors.js";
import { createRefreshGuard } from "./refresh-singleton.js";

interface RecordedEvent {
  event: string;
  props: Record<string, unknown>;
}

function makeRecorder(): { adapter: AnalyticsAdapter; events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  return {
    events,
    adapter: {
      track: (event, props) => {
        events.push({ event, props });
      },
      captureError: () => {},
    },
  };
}

/** A refresh whose settlement the test controls. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => resetAnalyticsAdapter());

describe("createRefreshGuard telemetry", () => {
  it("emits once per REAL refresh, not once per waiter", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    const gate = deferred<string>();
    let calls = 0;
    const guard = createRefreshGuard(() => {
      calls += 1;
      return gate.promise;
    });

    // Ten callers race on an expired token — the scenario the guard exists for.
    const waiters = Array.from({ length: 10 }, () => guard.refresh());
    gate.resolve("new-token");
    await Promise.all(waiters);

    expect(calls).toBe(1);
    // This is the property that makes a refresh storm visible: the event counts
    // refreshes, not contention. Emitting from the call sites instead would make a
    // storm — the thing the SLO watches for — look identical to normal traffic.
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("session_token_refreshed");
    expect(events[0].props.latency_ms).toEqual(expect.any(Number));
  });

  it("emits a failure event and re-throws the original error", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    const boom = new BBApiError("unauthorized", 401, { kind: "http" });
    const guard = createRefreshGuard(() => Promise.reject(boom));

    await expect(guard.refresh()).rejects.toBe(boom);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("session_token_refresh_failed");
    expect(events[0].props).toEqual({ error_code: "401" });
  });

  it("clears the in-flight promise after a failure so a later refresh can retry", async () => {
    const { adapter } = makeRecorder();
    setAnalyticsAdapter(adapter);
    let calls = 0;
    const guard = createRefreshGuard(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("nope")) : Promise.resolve("ok");
    });

    await expect(guard.refresh()).rejects.toThrow();
    expect(guard.isInflight()).toBe(false);
    await expect(guard.refresh()).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  describe("error_code distinguishes the failures that demand different responses", () => {
    /**
     * `statusCode` is `0` for every kind except `http`, so coding from it alone
     * files an unreachable IdP, a timeout and a user-cancelled refresh all as
     * `"0"` — one bucket, three opposite remedies. A credential problem needs
     * re-auth; an outage needs a retry; neither is visible if they look the same.
     */
    const cases: ReadonlyArray<readonly [BBApiError, string]> = [
      [new BBApiError("gone", 401, { kind: "http" }), "401"],
      [new BBApiError("down", 503, { kind: "http" }), "503"],
      [new BBApiError("offline", 0, { kind: "network" }), "network"],
      [new BBApiError("slow", 0, { kind: "timeout" }), "timeout"],
      [new BBApiError("cancelled", 0, { kind: "aborted" }), "aborted"],
    ];

    for (const [error, expected] of cases) {
      it(`codes ${error.kind}/${error.statusCode} as ${expected}`, async () => {
        const { adapter, events } = makeRecorder();
        setAnalyticsAdapter(adapter);
        const guard = createRefreshGuard(() => Promise.reject(error));

        await expect(guard.refresh()).rejects.toBe(error);

        expect(events[0].props).toEqual({ error_code: expected });
      });
    }
  });
});
