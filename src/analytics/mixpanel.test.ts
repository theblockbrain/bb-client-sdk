import { afterEach, describe, expect, it } from "vitest";

import { resetAnalyticsAdapter, setAnalyticsAdapter, trackApiError, trackEvent } from "./index.js";
import type { MixpanelClient } from "./mixpanel.js";
import { createMixpanelAdapter } from "./mixpanel.js";

interface RecordedTrack {
  event: string;
  props?: Record<string, unknown>;
}

/**
 * Test double for the structural {@link MixpanelClient} — the same shape a real
 * `mixpanel-browser` instance satisfies. Proves the adapter needs no dependency.
 */
function makeMixpanelDouble(overrides: Partial<MixpanelClient> = {}) {
  const tracked: RecordedTrack[] = [];
  const registered: Record<string, unknown>[] = [];
  const identified: string[] = [];
  const groups: [string, string][] = [];
  const client: MixpanelClient = {
    track: (event, properties) => {
      tracked.push({ event, props: properties });
    },
    identify: distinctId => {
      identified.push(distinctId);
    },
    register: props => {
      registered.push(props);
    },
    set_group: (groupKey, groupId) => {
      groups.push([groupKey, groupId]);
    },
    ...overrides,
  };
  return { client, tracked, registered, identified, groups };
}

const superProps = { surface: "outlook-addin", env: "prod", sdk_version: "0.18.0" } as const;

afterEach(() => resetAnalyticsAdapter());

describe("createMixpanelAdapter", () => {
  it("registers the super-props once at creation", () => {
    const { client, registered } = makeMixpanelDouble();

    createMixpanelAdapter(client, { superProps: { ...superProps } });

    expect(registered).toEqual([{ ...superProps }]);
  });

  it("forwards typed events with per-event identity and tenant roll-up", () => {
    const { client, tracked } = makeMixpanelDouble();
    setAnalyticsAdapter(createMixpanelAdapter(client, { superProps: { ...superProps } }));

    trackEvent(
      "sign_in_completed",
      { method: "oidc", latency_ms: 42 },
      { distinctId: "sub-1", orgId: "org-1" },
    );

    expect(tracked).toEqual([
      {
        event: "sign_in_completed",
        props: {
          method: "oidc",
          latency_ms: 42,
          // Per-event identity must ride along, so one process-wide adapter is
          // safe for a multi-tenant Node backend serving many orgs.
          distinct_id: "sub-1",
          tenant_id: "org-1",
        },
      },
    ]);
  });

  it("keeps status_code and error_name — the denylist must not over-match", () => {
    const { client, tracked } = makeMixpanelDouble();
    const adapter = createMixpanelAdapter(client, { superProps: { ...superProps } });
    setAnalyticsAdapter(adapter);

    // Regression guard: `status_code` normalizes to "statuscode" and `error_name` to
    // "errorname". A substring rule against "code"/"name" would silently delete both
    // and gut these payloads.
    trackEvent("api_error", { status_code: 500, endpoint: "/x", method: "POST" });
    adapter.captureError(new RangeError("boom"));

    expect(tracked[0].props).toEqual({ status_code: 500, endpoint: "/x", method: "POST" });
    expect(tracked[1].props).toEqual({ error_name: "RangeError" });
  });

  it("scrubs denylisted keys regardless of casing or separators", () => {
    const { client, tracked } = makeMixpanelDouble();
    const adapter = createMixpanelAdapter(client, { superProps: { ...superProps } });

    adapter.captureError(new Error("x"), {
      scope: "auth",
      Email: "a@b.com",
      Access_Token: "leak-1",
      "refresh-token": "leak-2",
      AUTHORIZATION: "Bearer leak-3",
    });

    expect(tracked[0].props).toEqual({ error_name: "Error", scope: "auth" });
    const serialized = JSON.stringify(tracked);
    for (const secret of ["a@b.com", "leak-1", "leak-2", "leak-3"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("drops non-primitive values outright — a nested object can never leak", () => {
    const { client, tracked } = makeMixpanelDouble();
    const adapter = createMixpanelAdapter(client, { superProps: { ...superProps } });

    // An untyped (plain-JS) caller handing over a whole BBApiError-shaped object.
    adapter.captureError(new Error("x"), {
      scope: "api",
      detail: { responseBody: { access_token: "nested-should-never-leak" } },
    } as never);

    expect(tracked[0].props).toEqual({ error_name: "Error", scope: "api" });
    expect(JSON.stringify(tracked)).not.toContain("nested-should-never-leak");
  });

  it("drops non-JSON-safe primitives without costing the rest of the event", () => {
    const { client, tracked } = makeMixpanelDouble();
    const adapter = createMixpanelAdapter(client, { superProps: { ...superProps } });

    // `bigint` and `symbol` are primitives but not JSON-safe: JSON.stringify throws
    // on the former and silently omits the latter. Mixpanel serializes the payload,
    // so letting a bigint through would throw inside track(), hit the adapter's
    // catch, and lose the WHOLE event. Drop the field, keep the event.
    adapter.captureError(new Error("x"), {
      scope: "api",
      attempt: 9_007_199_254_740_993n,
      marker: Symbol("nope"),
    } as never);

    expect(tracked[0].props).toEqual({ error_name: "Error", scope: "api" });
    // The payload must survive a JSON round-trip — the thing Mixpanel actually does.
    expect(() => JSON.stringify(tracked[0].props)).not.toThrow();
  });

  it("derived fields win over caller-supplied ones of the same name", () => {
    const { client, tracked } = makeMixpanelDouble();
    const adapter = createMixpanelAdapter(client, { superProps: { ...superProps } });

    adapter.captureError(new TypeError("x"), {
      scope: "auth",
      orgId: "org-real",
      tenant_id: "org-spoofed",
      error_name: "Ignore",
    });

    expect(tracked[0].props).toEqual({
      error_name: "TypeError",
      tenant_id: "org-real",
      scope: "auth",
    });
  });

  it("honours a custom group key", () => {
    const { client, tracked, groups } = makeMixpanelDouble();
    const adapter = createMixpanelAdapter(client, {
      superProps: { ...superProps },
      groupKey: "org_id",
    });

    adapter.track("stream_started", { route: "agent" }, { orgId: "org-9" });
    adapter.group?.("org-9");

    expect(tracked[0].props).toEqual({ route: "agent", org_id: "org-9" });
    expect(groups).toEqual([["org_id", "org-9"]]);
  });

  it("drops undefined props rather than sending them", () => {
    const { client, tracked } = makeMixpanelDouble();
    setAnalyticsAdapter(createMixpanelAdapter(client, { superProps: { ...superProps } }));

    trackEvent("message_completed", {
      route: "chat",
      request_id: undefined,
      duration_ms: 120,
      outcome: "success",
    });

    expect(tracked[0].props).toEqual({ route: "chat", duration_ms: 120, outcome: "success" });
  });

  it("never forwards a response body or any other denylisted field", () => {
    const { client, tracked } = makeMixpanelDouble();
    setAnalyticsAdapter(createMixpanelAdapter(client, { superProps: { ...superProps } }));

    // The sink already scrubs api_error down to status_code + endpoint; the
    // adapter's denylist is the second line of defence.
    trackApiError({
      name: "BBApiError",
      statusCode: 503,
      endpoint: "/cortex/completions/v2/user-input",
      responseBody: { access_token: "token-abc-should-never-leak" },
    });

    expect(tracked).toHaveLength(1);
    expect(tracked[0].props).toEqual({
      status_code: 503,
      endpoint: "/cortex/completions/v2/user-input",
    });
    expect(JSON.stringify(tracked)).not.toContain("token-abc-should-never-leak");
  });

  it("captureError sends only the error NAME — never the message or stack", () => {
    const { client, tracked } = makeMixpanelDouble();
    const adapter = createMixpanelAdapter(client, { superProps: { ...superProps } });

    adapter.captureError(new TypeError("secret@example.com failed"), {
      scope: "auth",
      distinctId: "sub-2",
      orgId: "org-2",
    });

    expect(tracked).toEqual([
      {
        event: "sdk_error",
        props: {
          error_name: "TypeError",
          // The pseudonymous Zitadel `sub` is the identity model — it rides along
          // deliberately, per event, so a shared sink attributes correctly.
          distinct_id: "sub-2",
          tenant_id: "org-2",
          scope: "auth",
        },
      },
    ]);
    // The error's message must never leak — it can carry PII, as here.
    expect(JSON.stringify(tracked)).not.toContain("secret@example.com");
  });

  it("identify uses the pseudonymous id as-is", () => {
    const { client, identified } = makeMixpanelDouble();
    const adapter = createMixpanelAdapter(client, { superProps: { ...superProps } });

    adapter.identify?.("zitadel-sub-123");

    expect(identified).toEqual(["zitadel-sub-123"]);
  });

  it("group registers the tenant and calls set_group", () => {
    const { client, registered, groups } = makeMixpanelDouble();
    const adapter = createMixpanelAdapter(client, { superProps: { ...superProps } });

    adapter.group?.("org-7");

    expect(registered).toEqual([{ ...superProps }, { tenant_id: "org-7" }]);
    expect(groups).toEqual([["tenant_id", "org-7"]]);
  });

  it("tolerates a client without the optional set_group", () => {
    const { client } = makeMixpanelDouble({ set_group: undefined });
    const adapter = createMixpanelAdapter(client, { superProps: { ...superProps } });

    expect(() => adapter.group?.("org-8")).not.toThrow();
  });

  it("the consent gate makes every method a silent no-op", () => {
    const { client, tracked, registered, identified, groups } = makeMixpanelDouble();
    const adapter = createMixpanelAdapter(client, {
      enabled: false,
      superProps: { ...superProps },
    });

    adapter.track(
      "message_sent",
      { conversation_id: "c-1", message_id: "m-1", route: "chat" },
      { orgId: "org-1" },
    );
    adapter.captureError(new Error("boom"));
    adapter.identify?.("sub-3");
    adapter.group?.("org-3");

    expect(registered).toEqual([]);
    expect(tracked).toEqual([]);
    expect(identified).toEqual([]);
    expect(groups).toEqual([]);
  });

  it("never throws out of setup, identify or group when the client faults", () => {
    const throwing = (): never => {
      throw new Error("mixpanel down");
    };
    const { client } = makeMixpanelDouble({
      register: throwing,
      identify: throwing,
      set_group: throwing,
    });

    let adapter: ReturnType<typeof createMixpanelAdapter> | undefined;
    expect(() => {
      adapter = createMixpanelAdapter(client, { superProps: { ...superProps } });
    }).not.toThrow();
    expect(() => adapter?.identify?.("sub-4")).not.toThrow();
    expect(() => adapter?.group?.("org-4")).not.toThrow();
  });

  it("a faulting track cannot break a product flow — the sink swallows it", () => {
    const { client } = makeMixpanelDouble({
      track: () => {
        throw new Error("mixpanel down");
      },
    });
    setAnalyticsAdapter(createMixpanelAdapter(client, { superProps: { ...superProps } }));

    expect(() =>
      trackEvent("message_sent", { conversation_id: "c-1", message_id: "m-1", route: "chat" }),
    ).not.toThrow();
  });
});
