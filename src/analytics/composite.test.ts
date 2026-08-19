import { describe, expect, it, vi } from "vitest";

import type { AnalyticsAdapter } from "../adapters/analytics.js";
import { createCompositeAdapter } from "./composite.js";

function makeSink(overrides: Partial<AnalyticsAdapter> = {}): {
  adapter: AnalyticsAdapter;
  tracked: string[];
  errors: unknown[];
} {
  const tracked: string[] = [];
  const errors: unknown[] = [];
  return {
    tracked,
    errors,
    adapter: {
      track: e => {
        tracked.push(e);
      },
      captureError: err => {
        errors.push(err);
      },
      ...overrides,
    },
  };
}

const SEND = { conversation_id: "c-1", message_id: "m-1", route: "chat" } as const;

describe("createCompositeAdapter", () => {
  it("fans one event out to every sink", () => {
    const a = makeSink();
    const b = makeSink();
    createCompositeAdapter([a.adapter, b.adapter]).track("message_sent", SEND);

    expect(a.tracked).toEqual(["message_sent"]);
    expect(b.tracked).toEqual(["message_sent"]);
  });

  it("drops null/undefined children so callers can compose conditionally", () => {
    const a = makeSink();
    const composite = createCompositeAdapter([null, a.adapter, undefined]);

    expect(() => composite.track("message_sent", SEND)).not.toThrow();
    expect(a.tracked).toEqual(["message_sent"]);
  });

  it("a throwing sink does not stop the sinks after it", () => {
    // The whole reason this module exists: a single try/catch around the loop
    // would let a broken Mixpanel silently take Sentry down with it.
    const broken: AnalyticsAdapter = {
      track: () => {
        throw new Error("mixpanel down");
      },
      captureError: () => {
        throw new Error("mixpanel down");
      },
    };
    const healthy = makeSink();
    const composite = createCompositeAdapter([broken, healthy.adapter]);

    expect(() => composite.track("message_sent", SEND)).not.toThrow();
    expect(() => composite.captureError(new Error("boom"))).not.toThrow();
    expect(healthy.tracked).toEqual(["message_sent"]);
    expect(healthy.errors).toHaveLength(1);
  });

  it("omits identify/group/flush when NO child implements them", () => {
    // Presence is contractual: the sink's identifyUser/setAnalyticsGroup no-op on
    // absence, which is how a multi-tenant Slack process avoids a process-wide
    // identity. Declaring them unconditionally would erase that signal.
    const composite = createCompositeAdapter([makeSink().adapter]);

    // `typeof` rather than reading the reference: the method is intentionally
    // absent, and its absence is what the sink's guarded helpers key off.
    expect(typeof composite.identify).toBe("undefined");
    expect(typeof composite.group).toBe("undefined");
    expect(typeof composite.flush).toBe("undefined");
  });

  it("declares identify/group when at least one child implements them", () => {
    const identify = vi.fn();
    const group = vi.fn();
    const withIdentity = makeSink({ identify, group });
    const composite = createCompositeAdapter([makeSink().adapter, withIdentity.adapter]);

    composite.identify?.("sub-1");
    composite.group?.("org-1");

    expect(identify).toHaveBeenCalledWith("sub-1", undefined);
    expect(group).toHaveBeenCalledWith("org-1", undefined);
  });

  it("flush waits on every sink and resolves even when one rejects", async () => {
    const slow = vi.fn().mockResolvedValue(undefined);
    const failing = vi.fn().mockRejectedValue(new Error("no network"));
    const composite = createCompositeAdapter([
      makeSink({ flush: failing }).adapter,
      makeSink({ flush: slow }).adapter,
    ]);

    // Runs at unload — one dead sink must not cost the other its flush.
    await expect(composite.flush?.()).resolves.toBeUndefined();
    expect(slow).toHaveBeenCalled();
    expect(failing).toHaveBeenCalled();
  });
});
