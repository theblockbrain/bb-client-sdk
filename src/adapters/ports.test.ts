import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWebCryptoAdapter,
  getCryptoAdapter,
  resetCryptoAdapter,
  setCryptoAdapter,
} from "./crypto.js";
import { getFeatureVariant, isFeatureEnabled, resetFlagAdapter, setFlagAdapter } from "./flags.js";
import { createHostCapabilityRegistry, routeToolCall } from "./host-capability.js";

afterEach(() => {
  resetCryptoAdapter();
  resetFlagAdapter();
  vi.restoreAllMocks();
});

/**
 * L7 · crypto. The point of the port is that a runtime with no Web Crypto can
 * still complete PKCE and send a message — on Hermes those were hard crashes,
 * two of them on the mainline send path.
 */
describe("CryptoAdapter", () => {
  it("prefers a registered adapter over the platform default", () => {
    setCryptoAdapter({
      randomUUID: () => "host-uuid",
      getRandomValues: bytes => bytes.fill(7),
      digest: () => Promise.resolve(new ArrayBuffer(32)),
    });

    expect(getCryptoAdapter().randomUUID()).toBe("host-uuid");
    expect(Array.from(getCryptoAdapter().getRandomValues(new Uint8Array(2)))).toEqual([7, 7]);
  });

  it("falls back to the platform default once the adapter is cleared", () => {
    setCryptoAdapter({
      randomUUID: () => "host-uuid",
      getRandomValues: b => b,
      digest: () => Promise.resolve(new ArrayBuffer(0)),
    });
    resetCryptoAdapter();

    // A real UUID from the environment's own crypto, not the stub.
    expect(getCryptoAdapter().randomUUID()).not.toBe("host-uuid");
    expect(getCryptoAdapter().randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("synthesises a v4 UUID when the source lacks randomUUID", () => {
    // Safari shipped getRandomValues years before randomUUID, so this path is real.
    const source = {
      getRandomValues: <T extends ArrayBufferView>(array: T): T => {
        new Uint8Array(array.buffer).fill(0xab);
        return array;
      },
      subtle: { digest: () => Promise.resolve(new ArrayBuffer(32)) },
    };

    const uuid = createWebCryptoAdapter(source).randomUUID();

    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("explains what to do when no crypto exists at all", () => {
    // The message has to name the fix: this is what an RN developer sees first.
    const adapter = createWebCryptoAdapter(undefined);
    vi.spyOn(globalThis, "crypto", "get").mockReturnValue(undefined as unknown as Crypto);

    expect(() => adapter.randomUUID()).toThrow(/setCryptoAdapter/);
  });
});

/** L7 · host capabilities. Routing must never throw into the stream loop. */
describe("HostCapabilityRegistry", () => {
  it("routes a call to the registered capability", async () => {
    const registry = createHostCapabilityRegistry([
      { id: "word.insertText", run: (args: unknown) => Promise.resolve(`wrote:${String(args)}`) },
    ]);

    await expect(routeToolCall(registry, "word.insertText", "hi")).resolves.toEqual({
      ok: true,
      value: "wrote:hi",
    });
  });

  it("reports an unknown tool instead of throwing", async () => {
    // The agent can be newer than the host, so this is a normal condition.
    const result = await routeToolCall(createHostCapabilityRegistry(), "outlook.doThing", {});

    expect(result).toMatchObject({ ok: false, reason: "unknown-capability" });
  });

  it("converts a rejecting capability into a failed result", async () => {
    const registry = createHostCapabilityRegistry([
      { id: "excel.read", run: () => Promise.reject(new Error("no selection")) },
    ]);

    // An exception here would tear down the turn the way an unguarded observer did.
    await expect(routeToolCall(registry, "excel.read", {})).resolves.toEqual({
      ok: false,
      reason: "failed",
      message: "no selection",
    });
  });

  it("replaces a re-registered id and lists what it holds", () => {
    const registry = createHostCapabilityRegistry();
    registry.register({ id: "a", run: () => Promise.resolve(1) });
    registry.register({ id: "a", run: () => Promise.resolve(2) });
    registry.register({ id: "b", run: () => Promise.resolve(3) });

    expect(registry.ids()).toEqual(["a", "b"]);
    expect(registry.has("a")).toBe(true);
  });
});

/** L10 · flags. Reads happen on a render path, so they are sync and total. */
describe("FlagAdapter", () => {
  it("returns the caller's fallback when no adapter is wired", () => {
    expect(isFeatureEnabled("new-thing")).toBe(false);
    expect(isFeatureEnabled("opt-out-thing", true)).toBe(true);
  });

  it("passes the fallback through so opt-in and opt-out stay the caller's choice", () => {
    const isEnabled = vi.fn((_flag: string, fallback: boolean) => fallback);
    setFlagAdapter({ isEnabled });

    expect(isFeatureEnabled("x", true)).toBe(true);
    expect(isEnabled).toHaveBeenCalledWith("x", true);
  });

  it("swallows a throwing adapter and degrades to the fallback", () => {
    // A host's flag bug must not take down the feature it was meant to gate.
    setFlagAdapter({
      isEnabled: () => {
        throw new Error("provider exploded");
      },
    });

    expect(() => isFeatureEnabled("x", true)).not.toThrow();
    expect(isFeatureEnabled("x", true)).toBe(true);
  });

  it("returns null for a variant when the adapter does not support them", () => {
    setFlagAdapter({ isEnabled: () => true });
    expect(getFeatureVariant("x")).toBeNull();
  });

  it("reads a variant when supported, and null when it throws", () => {
    setFlagAdapter({ isEnabled: () => true, getVariant: () => "arm-b" });
    expect(getFeatureVariant("x")).toBe("arm-b");

    setFlagAdapter({
      isEnabled: () => true,
      getVariant: () => {
        throw new Error("nope");
      },
    });
    expect(getFeatureVariant("x")).toBeNull();
  });
});
