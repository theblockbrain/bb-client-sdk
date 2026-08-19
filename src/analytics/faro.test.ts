import { describe, expect, it } from "vitest";

import { createFaroAdapter, type FaroLike, type FaroUser } from "./faro.js";

function makeFaroDouble(): {
  faro: FaroLike;
  events: { name: string; attributes?: Record<string, string>; domain?: string }[];
  errors: Error[];
  users: FaroUser[];
} {
  const events: { name: string; attributes?: Record<string, string>; domain?: string }[] = [];
  const errors: Error[] = [];
  const users: FaroUser[] = [];
  return {
    events,
    errors,
    users,
    faro: {
      api: {
        pushEvent: (name, attributes, domain) => {
          events.push({ name, attributes, domain });
        },
        pushError: error => {
          errors.push(error);
        },
        setUser: user => {
          users.push(user);
        },
      },
    },
  };
}

describe("createFaroAdapter", () => {
  it("pushes the event name, stringified attributes and the domain", () => {
    const { faro, events } = makeFaroDouble();

    createFaroAdapter(faro).track(
      "message_first_token",
      { route: "chat", request_id: "r-1", ttft_ms: 1234 },
      { distinctId: "sub-1", orgId: "org-1" },
    );

    expect(events[0].name).toBe("message_first_token");
    expect(events[0].domain).toBe("blockbrain");
    // Faro's contract is Record<string, string> — numbers must survive as strings
    // rather than be dropped, or the latency panel has nothing to read.
    expect(events[0].attributes).toEqual({
      route: "chat",
      request_id: "r-1",
      ttft_ms: "1234",
      distinct_id: "sub-1",
      tenant_id: "org-1",
    });
  });

  it("keeps the user id when a group is bound afterwards", () => {
    // Faro's setUser REPLACES rather than merges. Binding the tenant after the
    // user must not silently erase the user, or every later event is anonymous.
    const { faro, users } = makeFaroDouble();
    const adapter = createFaroAdapter(faro);

    adapter.identify?.("sub-7");
    adapter.group?.("org-7");

    expect(users.at(-1)).toEqual({ id: "sub-7", attributes: { tenant_id: "org-7" } });
  });

  it("never sends an email or username to Faro", () => {
    const { faro, users, events } = makeFaroDouble();
    const adapter = createFaroAdapter(faro);

    adapter.identify?.("sub-1");
    // The claim bag this guard exists for. `mail`/`user_email`/`username`/
    // `given_name`/`family_name` are the OIDC + Zitadel claim spellings, so a
    // surface that spreads a profile object into props hits exactly these; the
    // cast is the untyped (plain-JS) caller the runtime scrub is the backstop
    // for. The previous version of this test asserted the same regex while
    // passing NO such key, so it held whatever the denylist happened to be.
    adapter.track("api_error", {
      status_code: 500,
      endpoint: "/x",
      mail: "alice@corp.example",
      user_email: "alice@corp.example",
      username: "alice",
      preferred_username: "alice",
      given_name: "Alice",
      family_name: "Smith",
    } as unknown as { status_code: number });

    expect(events.at(-1)?.attributes).toEqual({ status_code: "500", endpoint: "/x" });
    expect(JSON.stringify({ users, events })).not.toMatch(/email|username|alice|Smith/i);
  });

  it("scrubs a denylisted field smuggled in by an untyped caller", () => {
    const { faro, events } = makeFaroDouble();
    const props = { status_code: 500, access_token: "leak-me" } as unknown as {
      status_code: number;
    };

    createFaroAdapter(faro).track("api_error", props);

    expect(events[0].attributes).toEqual({ status_code: "500" });
    expect(JSON.stringify(events)).not.toContain("leak-me");
  });

  it("wraps a thrown non-Error without interpolating its value", () => {
    const { faro, errors } = makeFaroDouble();

    createFaroAdapter(faro).captureError({ access_token: "leak-me" });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).not.toContain("leak-me");
  });

  it("no-ops entirely when consent is withheld", () => {
    const { faro, events, errors, users } = makeFaroDouble();
    const adapter = createFaroAdapter(faro, { enabled: false });

    adapter.track("message_sent", { conversation_id: "c", message_id: "m", route: "chat" });
    adapter.captureError(new Error("boom"));
    adapter.identify?.("sub-1");
    adapter.group?.("org-1");

    expect(events).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(users).toHaveLength(0);
  });

  it("never throws when the underlying Faro instance faults", () => {
    const faro: FaroLike = {
      api: {
        pushEvent: () => {
          throw new Error("collector unreachable");
        },
        pushError: () => {
          throw new Error("collector unreachable");
        },
        setUser: () => {
          throw new Error("collector unreachable");
        },
      },
    };
    const adapter = createFaroAdapter(faro);

    expect(() => adapter.track("api_error", { status_code: 500 })).not.toThrow();
    expect(() => adapter.captureError(new Error("boom"))).not.toThrow();
    expect(() => adapter.identify?.("sub-1")).not.toThrow();
  });
});
