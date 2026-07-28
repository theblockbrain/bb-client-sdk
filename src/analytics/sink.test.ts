import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsAdapter, AnalyticsIdentity } from "./index.js";
import {
  captureError,
  flushAnalytics,
  getAnalyticsAdapter,
  identifyUser,
  resetAnalyticsAdapter,
  setAnalyticsAdapter,
  setAnalyticsGroup,
  trackApiError,
  trackEvent,
} from "./index.js";

interface RecordedEvent {
  event: string;
  props: unknown;
  identity?: AnalyticsIdentity;
}

function makeRecorder(overrides: Partial<AnalyticsAdapter> = {}) {
  const events: RecordedEvent[] = [];
  const errors: { error: unknown; context?: unknown }[] = [];
  const adapter: AnalyticsAdapter = {
    track: (event, props, identity) => {
      events.push({ event, props, identity });
    },
    captureError: (error, context) => {
      errors.push({ error, context });
    },
    ...overrides,
  };
  return { adapter, events, errors };
}

afterEach(() => resetAnalyticsAdapter());

describe("analytics sink", () => {
  it("no-ops (and never throws) when no adapter is registered", () => {
    expect(getAnalyticsAdapter()).toBeNull();
    expect(() => trackEvent("auth_started", { mode: "oauth" })).not.toThrow();
    expect(() => captureError(new Error("x"))).not.toThrow();
    expect(() => trackApiError({ statusCode: 500, endpoint: "/x" })).not.toThrow();
  });

  it("forwards typed events with props and identity", () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    trackEvent(
      "auth_success",
      { mode: "oauth", latencyMs: 42 },
      { distinctId: "sub-1", orgId: "org-1" },
    );

    expect(events).toEqual([
      {
        event: "auth_success",
        props: { mode: "oauth", latencyMs: 42 },
        identity: { distinctId: "sub-1", orgId: "org-1" },
      },
    ]);
  });

  it("swallows adapter faults — telemetry never breaks the SDK", () => {
    setAnalyticsAdapter({
      track: () => {
        throw new Error("mixpanel down");
      },
      captureError: () => {
        throw new Error("sentry down");
      },
    });

    expect(() => trackEvent("message_send", { streaming: true })).not.toThrow();
    expect(() => captureError(new Error("boom"))).not.toThrow();
  });

  it("trackApiError forwards ONLY statusCode + endpoint (never responseBody)", () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    trackApiError({
      name: "BBApiError",
      statusCode: 503,
      endpoint: "/cortex/completions/v2/user-input",
      // A secret-bearing body must never reach analytics.
      responseBody: { access_token: "token-abc-should-never-leak" },
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("api_error");
    expect(events[0].props).toEqual({
      statusCode: 503,
      endpoint: "/cortex/completions/v2/user-input",
    });
    expect(JSON.stringify(events[0])).not.toContain("token-abc-should-never-leak");
  });

  it("trackApiError ignores errors without a numeric statusCode", () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    trackApiError(new Error("network down"));

    expect(events).toHaveLength(0);
  });

  it("captureError forwards the error and context to the adapter", () => {
    const { adapter, errors } = makeRecorder();
    setAnalyticsAdapter(adapter);
    const err = new Error("boom");

    captureError(err, { scope: "auth", distinctId: "sub-2" });

    expect(errors).toEqual([{ error: err, context: { scope: "auth", distinctId: "sub-2" } }]);
  });

  it("forwards optional identify/group when the adapter implements them", () => {
    const identify = vi.fn();
    const group = vi.fn();
    const { adapter } = makeRecorder({ identify, group });
    setAnalyticsAdapter(adapter);

    identifyUser("sub-9");
    setAnalyticsGroup("org-9");

    expect(identify).toHaveBeenCalledWith("sub-9");
    expect(group).toHaveBeenCalledWith("org-9");
  });

  it("identifyUser/setAnalyticsGroup no-op when the adapter omits them", () => {
    const { adapter } = makeRecorder();
    setAnalyticsAdapter(adapter);
    // The base recorder implements only the required methods — as a multi-tenant
    // server adapter must, since identify/group bind process-wide.
    expect("identify" in adapter).toBe(false);
    expect("group" in adapter).toBe(false);

    expect(() => identifyUser("sub-9")).not.toThrow();
    expect(() => setAnalyticsGroup("org-9")).not.toThrow();
  });

  it("identifyUser/setAnalyticsGroup no-op when no adapter is registered", () => {
    expect(getAnalyticsAdapter()).toBeNull();
    expect(() => identifyUser("sub-9")).not.toThrow();
    expect(() => setAnalyticsGroup("org-9")).not.toThrow();
  });

  it("swallows identify/group faults — a throwing adapter never breaks the SDK", () => {
    setAnalyticsAdapter({
      track: () => {},
      captureError: () => {},
      identify: () => {
        throw new Error("mixpanel down");
      },
      group: () => {
        throw new Error("mixpanel down");
      },
    });

    expect(() => identifyUser("sub-9")).not.toThrow();
    expect(() => setAnalyticsGroup("org-9")).not.toThrow();
  });

  it("flushAnalytics awaits flush and resolves even when it rejects", async () => {
    const flush = vi.fn().mockRejectedValue(new Error("flush failed"));
    setAnalyticsAdapter({ track: () => {}, captureError: () => {}, flush });

    await expect(flushAnalytics()).resolves.toBeUndefined();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("flushAnalytics is a safe no-op when no adapter or no flush is present", async () => {
    await expect(flushAnalytics()).resolves.toBeUndefined();
    setAnalyticsAdapter({ track: () => {}, captureError: () => {} });
    await expect(flushAnalytics()).resolves.toBeUndefined();
  });

  it("resetAnalyticsAdapter detaches the current adapter", () => {
    setAnalyticsAdapter({ track: () => {}, captureError: () => {} });
    expect(getAnalyticsAdapter()).not.toBeNull();

    resetAnalyticsAdapter();

    expect(getAnalyticsAdapter()).toBeNull();
  });
});
