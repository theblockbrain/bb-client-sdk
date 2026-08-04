import { describe, expect, it, vi } from "vitest";
import { createWebStorageAdapter } from "./web-storage.js";

/**
 * The adapter is a pass-through on purpose (PDEV-7724).
 *
 * An encoding layer here would change the bytes on disk, which breaks two things
 * that are easy to forget: values written by the previous direct-`localStorage`
 * code, and anything else sharing the key — a pre-paint theme bootstrap script
 * reading `bb-theme` to set `data-theme` before first render, for instance. So
 * these tests assert the *stored form*, not just the round-trip.
 */
function fakeArea(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const area = {
    getItem: vi.fn((k: string) => map.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => {
      map.set(k, v);
    }),
    removeItem: vi.fn((k: string) => {
      map.delete(k);
    }),
  };
  return { area: area as unknown as Storage, raw: map, spies: area };
}

describe("createWebStorageAdapter", () => {
  it("stores the value verbatim — no encoding layer", () => {
    const { area, raw } = fakeArea();
    createWebStorageAdapter(area).set("bb-theme", "dark");

    // Not '"dark"'. A JSON layer here would break a pre-paint bootstrap script.
    expect(raw.get("bb-theme")).toBe("dark");
  });

  it("reads a value written directly, before the port existed", () => {
    const { area } = fakeArea({ "bb-theme": "light" });
    expect(createWebStorageAdapter(area).get("bb-theme")).toBe("light");
  });

  it("returns null for a missing key rather than throwing", () => {
    const { area } = fakeArea();
    expect(createWebStorageAdapter(area).get("absent")).toBeNull();
  });

  it("delegates removal to the area", () => {
    const { area, raw, spies } = fakeArea({ k: "v" });
    createWebStorageAdapter(area).remove("k");

    expect(spies.removeItem).toHaveBeenCalledWith("k");
    expect(raw.has("k")).toBe(false);
  });

  it("never touches a global — the area is the only source", () => {
    // Proves invariant B for this module: it works against an area that is not
    // localStorage at all, which is what lets Node and RN hosts supply their own.
    const { area, raw } = fakeArea();
    const store = createWebStorageAdapter(area);

    store.set("a", "1");
    expect(store.get("a")).toBe("1");
    expect(raw.get("a")).toBe("1");
  });
});
