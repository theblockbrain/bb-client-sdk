import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ConsentSource,
  type ConsentState,
  createConsentGate,
  createStaticConsentSource,
  createTogglableConsentSource,
} from "./consent.js";
import {
  COOKIEBOT_EVENTS,
  type ConsentEventTarget,
  type CookiebotLike,
  createCookiebotConsentSource,
} from "./cookiebot.js";

describe("createConsentGate — failing closed", () => {
  it("denies with no source at all", () => {
    // The default for a surface that has not wired consent yet: the sink is a
    // silent no-op rather than an unlawful emitter.
    const gate = createConsentGate();
    expect(gate.state()).toBe("denied");
    expect(gate.isAllowed()).toBe(false);
  });

  it("denies when the source throws from getState", () => {
    const gate = createConsentGate({
      getState: () => {
        throw new Error("CMP exploded");
      },
    });
    expect(gate.state()).toBe("denied");
    expect(gate.isAllowed()).toBe(false);
  });

  it("denies when the source returns a value outside the union", () => {
    const rogue = { getState: () => "yes-please" } as unknown as ConsentSource;
    expect(createConsentGate(rogue).isAllowed()).toBe(false);
  });

  it("does not treat unknown as permission", () => {
    // No answer is not a yes. This is the single most important assertion here.
    const gate = createConsentGate(createStaticConsentSource("unknown"));
    expect(gate.state()).toBe("unknown");
    expect(gate.isAllowed()).toBe(false);
  });

  it("allows only on granted", () => {
    expect(createConsentGate(createStaticConsentSource("granted")).isAllowed()).toBe(true);
    expect(createConsentGate(createStaticConsentSource("denied")).isAllowed()).toBe(false);
  });

  it("survives a source that cannot be subscribed to", () => {
    const gate = createConsentGate({
      getState: () => "granted",
      subscribe: () => {
        throw new Error("no listeners here");
      },
    });
    // Subscription failed, but the decision is still readable.
    expect(gate.isAllowed()).toBe(true);
  });
});

describe("createConsentGate — change propagation", () => {
  it("notifies subscribers on a real transition", () => {
    const { source, set } = createTogglableConsentSource("unknown");
    const gate = createConsentGate(source);
    const seen: ConsentState[] = [];
    gate.subscribe(s => seen.push(s));

    set("granted");
    set("denied");

    expect(seen).toEqual(["granted", "denied"]);
  });

  it("does NOT notify when the state has not actually changed", () => {
    // A CMP that re-broadcasts the same decision on every page view must not
    // cause repeated opt-in calls downstream.
    const listener = vi.fn();
    let state: ConsentState = "granted";
    const subscribers = new Set<() => void>();
    const source: ConsentSource = {
      getState: () => state,
      subscribe(cb) {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
    };
    const gate = createConsentGate(source);
    gate.subscribe(listener);

    // Re-broadcast the identical decision three times.
    for (let i = 0; i < 3; i++) for (const cb of subscribers) cb();
    expect(listener).not.toHaveBeenCalled();

    state = "denied";
    for (const cb of subscribers) cb();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", () => {
    const { source, set } = createTogglableConsentSource("unknown");
    const gate = createConsentGate(source);
    const listener = vi.fn();
    const off = gate.subscribe(listener);

    set("granted");
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    set("denied");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps notifying the other listeners when one throws", () => {
    const { source, set } = createTogglableConsentSource("unknown");
    const gate = createConsentGate(source);
    const good = vi.fn();
    gate.subscribe(() => {
      throw new Error("bad listener");
    });
    gate.subscribe(good);

    set("granted");
    expect(good).toHaveBeenCalledWith("granted");
  });

  it("reads through, so a source without subscribe cannot go stale", () => {
    // A host-supplied getter can change without telling us. A cached `granted`
    // is the one answer we must never give.
    let state: ConsentState = "granted";
    const gate = createConsentGate({ getState: () => state });
    expect(gate.isAllowed()).toBe(true);
    state = "denied";
    expect(gate.isAllowed()).toBe(false);
  });
});

describe("createConsentGate — dispose", () => {
  it("denies after dispose and detaches from the source", () => {
    const unsubscribe = vi.fn();
    const gate = createConsentGate({
      getState: () => "granted",
      subscribe: () => unsubscribe,
    });
    expect(gate.isAllowed()).toBe(true);

    gate.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(gate.state()).toBe("denied");
    expect(gate.isAllowed()).toBe(false);
  });

  it("is idempotent", () => {
    const unsubscribe = vi.fn();
    const gate = createConsentGate({
      getState: () => "granted",
      subscribe: () => unsubscribe,
    });
    gate.dispose();
    gate.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("survives an unsubscribe that throws", () => {
    const gate = createConsentGate({
      getState: () => "granted",
      subscribe: () => () => {
        throw new Error("teardown exploded");
      },
    });
    expect(() => gate.dispose()).not.toThrow();
  });

  it("stops notifying listeners after dispose", () => {
    const { source, set } = createTogglableConsentSource("unknown");
    const gate = createConsentGate(source);
    const listener = vi.fn();
    gate.subscribe(listener);
    gate.dispose();
    set("granted");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("createTogglableConsentSource", () => {
  it("starts unknown so a first-run screen shows exactly once", () => {
    const { source } = createTogglableConsentSource();
    expect(source.getState()).toBe("unknown");
  });

  it("does not notify when set to the value it already holds", () => {
    const { source, set } = createTogglableConsentSource("granted");
    const cb = vi.fn();
    source.subscribe?.(cb);
    set("granted");
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("createCookiebotConsentSource", () => {
  let cookiebot: CookiebotLike | undefined;
  let handlers: Map<string, Set<() => void>>;
  let target: ConsentEventTarget;

  beforeEach(() => {
    cookiebot = undefined;
    handlers = new Map();
    target = {
      addEventListener(type, listener) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type)?.add(listener);
      },
      removeEventListener(type, listener) {
        handlers.get(type)?.delete(listener);
      },
    };
  });

  const build = () => createCookiebotConsentSource({ getCookiebot: () => cookiebot, target });

  const fire = (type: string) => {
    for (const h of handlers.get(type) ?? []) h();
  };

  it("is unknown before the Cookiebot script has loaded", () => {
    expect(build().getState()).toBe("unknown");
  });

  it("is unknown when loaded but unanswered", () => {
    cookiebot = { hasResponse: false, consent: { statistics: false } };
    expect(build().getState()).toBe("unknown");
  });

  it("grants only on the statistics category", () => {
    cookiebot = { hasResponse: true, consent: { statistics: true } };
    expect(build().getState()).toBe("granted");
  });

  it("denies when the user accepted Marketing but declined Statistics", () => {
    // The substantive failure this gate exists to prevent: treating a refusal of
    // analytics as permission to do analytics.
    cookiebot = {
      hasResponse: true,
      consent: { necessary: true, marketing: true, preferences: true, statistics: false },
    };
    expect(build().getState()).toBe("denied");
  });

  it("denies when statistics is absent rather than assuming consent", () => {
    cookiebot = { hasResponse: true, consent: { necessary: true } };
    expect(build().getState()).toBe("denied");
  });

  it("denies when the getter throws", () => {
    const source = createCookiebotConsentSource({
      getCookiebot: () => {
        throw new Error("cross-origin");
      },
      target,
    });
    expect(source.getState()).toBe("denied");
  });

  it("picks up a Cookiebot script that arrives AFTER construction", () => {
    // The async-load case. Pinning the object once would leave the gate shut
    // forever; reading through the getter is what makes this work.
    const gate = createConsentGate(build());
    expect(gate.state()).toBe("unknown");

    cookiebot = { hasResponse: true, consent: { statistics: true } };
    fire("CookiebotOnConsentReady");

    expect(gate.state()).toBe("granted");
    expect(gate.isAllowed()).toBe(true);
  });

  it("resolves a RETURNING visitor via OnConsentReady alone", () => {
    // Neither OnAccept nor OnDecline fires for someone who already answered on a
    // previous visit. Listening only to those two is the classic bug: analytics
    // never starts for your existing users.
    const listener = vi.fn();
    const gate = createConsentGate(build());
    gate.subscribe(listener);

    cookiebot = { hasResponse: true, consent: { statistics: true } };
    fire("CookiebotOnConsentReady");

    expect(listener).toHaveBeenCalledWith("granted");
  });

  it("closes again on withdrawal, per GDPR Art. 7(3)", () => {
    cookiebot = { hasResponse: true, consent: { statistics: true } };
    const gate = createConsentGate(build());
    expect(gate.isAllowed()).toBe(true);

    cookiebot = { hasResponse: true, consent: { statistics: false } };
    fire("CookiebotOnDecline");

    expect(gate.isAllowed()).toBe(false);
  });

  it("subscribes to all three lifecycle events", () => {
    build().subscribe?.(() => undefined);
    for (const event of COOKIEBOT_EVENTS) {
      expect(handlers.get(event)?.size).toBe(1);
    }
  });

  it("removes every listener it attached on unsubscribe", () => {
    const off = build().subscribe?.(() => undefined);
    off?.();
    for (const event of COOKIEBOT_EVENTS) {
      expect(handlers.get(event)?.size ?? 0).toBe(0);
    }
  });

  it("keeps working when addEventListener throws for some events", () => {
    let calls = 0;
    const flaky: ConsentEventTarget = {
      addEventListener(type, listener) {
        calls += 1;
        if (calls === 1) throw new Error("blocked");
        target.addEventListener(type, listener);
      },
      removeEventListener: (type, listener) => target.removeEventListener(type, listener),
    };
    const source = createCookiebotConsentSource({
      getCookiebot: () => cookiebot,
      target: flaky,
    });
    const gate = createConsentGate(source);

    cookiebot = { hasResponse: true, consent: { statistics: true } };
    fire("CookiebotOnAccept");

    // A partially attached listener set still beats none.
    expect(gate.isAllowed()).toBe(true);
  });
});
