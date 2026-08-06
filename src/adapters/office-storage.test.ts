import { describe, expect, it, vi } from "vitest";
import {
  createOfficeStorageAdapter,
  type OfficeRuntimeStorageArea,
  type RoamingSettingsArea,
} from "./office-storage.js";
import type { WebStorageArea } from "./web-storage.js";

/**
 * The finding this module encodes: `roamingSettings.saveAsync` round-trips to the
 * mailbox server and returns 500 for sideloaded add-ins, so the write appears to
 * succeed and nothing persists. Hence local-first, roaming as a read-only
 * migration source. These tests pin that ordering, because the symptom of getting
 * it wrong (a user re-authenticating on every open) shows up nowhere near the cause.
 */

function fakeLocal(seed: Record<string, string> = {}): WebStorageArea {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

function fakeOfficeRuntime(seed: Record<string, string> = {}): OfficeRuntimeStorageArea {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => Promise.resolve(store.get(key) ?? null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

function fakeRoaming(seed: Record<string, unknown> = {}): RoamingSettingsArea {
  return { get: (key: string) => seed[key] };
}

/** Let the fire-and-forget mirror writes settle. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe("createOfficeStorageAdapter — reads", () => {
  it("returns null before warm(), even when a backend holds the key", () => {
    // Not a self-correcting cache miss: a zustand store hydrating from an empty
    // cache concludes the user is logged out and then persists that conclusion.
    const storage = createOfficeStorageAdapter({ local: fakeLocal({ session: "s1" }) });
    expect(storage.get("session")).toBeNull();
  });

  it("serves local storage as the source of truth", async () => {
    const storage = createOfficeStorageAdapter({ local: fakeLocal({ session: "s1" }) });
    await storage.warm("session");
    expect(storage.get("session")).toBe("s1");
  });

  it("prefers local over OfficeRuntime when both hold a value", async () => {
    const officeRuntime = fakeOfficeRuntime({ session: "stale" });
    const getItem = vi.spyOn(officeRuntime, "getItem");
    const storage = createOfficeStorageAdapter({
      local: fakeLocal({ session: "fresh" }),
      officeRuntime,
    });

    await storage.warm("session");

    expect(storage.get("session")).toBe("fresh");
    expect(getItem).not.toHaveBeenCalled();
  });

  it("repairs the OfficeRuntime mirror from the local value", async () => {
    const officeRuntime = fakeOfficeRuntime();
    const storage = createOfficeStorageAdapter({
      local: fakeLocal({ session: "s1" }),
      officeRuntime,
    });

    await storage.warm("session");
    await flush();

    await expect(officeRuntime.getItem("session")).resolves.toBe("s1");
  });

  it("serves a stored empty string as a value, not a miss", async () => {
    // `null` is absence; `""` is a stored value. Web Storage draws that line and
    // `createWebStorageAdapter` passes it through, so this adapter must agree —
    // two implementations of one port cannot disagree on what "absent" means.
    const storage = createOfficeStorageAdapter({ local: fakeLocal({ session: "" }) });
    await storage.warm("session");
    expect(storage.get("session")).toBe("");
  });

  it("promotes an empty string out of OfficeRuntime too", async () => {
    const local = fakeLocal();
    const storage = createOfficeStorageAdapter({
      local,
      officeRuntime: fakeOfficeRuntime({ session: "" }),
    });

    await storage.warm("session");

    expect(storage.get("session")).toBe("");
    expect(local.getItem("session")).toBe("");
  });

  it("promotes an OfficeRuntime value back into local when local is empty", async () => {
    // The real recovery path: local storage was cleared but the add-in's own
    // async store survived.
    const local = fakeLocal();
    const storage = createOfficeStorageAdapter({
      local,
      officeRuntime: fakeOfficeRuntime({ session: "s1" }),
    });

    await storage.warm("session");

    expect(storage.get("session")).toBe("s1");
    expect(local.getItem("session")).toBe("s1");
  });
});

describe("createOfficeStorageAdapter — the roamingSettings migration", () => {
  it("migrates a roaming value into local and reports it", async () => {
    const local = fakeLocal();
    const onDiagnostic = vi.fn();
    const storage = createOfficeStorageAdapter({
      local,
      roaming: fakeRoaming({ session: "legacy" }),
      onDiagnostic,
    });

    await storage.warm("session");

    expect(storage.get("session")).toBe("legacy");
    expect(local.getItem("session")).toBe("legacy");
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/Migrating "session"/),
      undefined,
    );
  });

  it("is consulted only after local and OfficeRuntime both miss", async () => {
    const roaming = fakeRoaming({ session: "legacy" });
    const get = vi.spyOn(roaming, "get");
    const storage = createOfficeStorageAdapter({
      local: fakeLocal({ session: "s1" }),
      roaming,
    });

    await storage.warm("session");

    expect(get).not.toHaveBeenCalled();
  });

  it("does not resurrect a legacy value over a deliberately-emptied key", async () => {
    // The reason `""` must not read as a miss. A caller that emptied the key would
    // otherwise fall through to the migration and get the old value written back
    // into local storage — a stale token silently restored after being cleared.
    const local = fakeLocal();
    const roaming = fakeRoaming({ session: "legacy" });
    const get = vi.spyOn(roaming, "get");
    const storage = createOfficeStorageAdapter({ local, roaming });

    storage.set("session", "");
    await storage.warm("session");

    expect(storage.get("session")).toBe("");
    expect(local.getItem("session")).toBe("");
    expect(get).not.toHaveBeenCalled();
  });

  it("migrates an empty-string roaming value", async () => {
    // `""` in the legacy store is a value the caller may read meaning into, so the
    // guard here is the type check alone — not truthiness.
    const storage = createOfficeStorageAdapter({
      local: fakeLocal(),
      roaming: fakeRoaming({ session: "" }),
    });

    await storage.warm("session");

    expect(storage.get("session")).toBe("");
  });

  it("ignores a non-string roaming value", async () => {
    // roamingSettings stores structured data natively, so a legacy key may hold
    // an object — migrating that into a string store would corrupt it.
    const storage = createOfficeStorageAdapter({
      local: fakeLocal(),
      roaming: fakeRoaming({ session: { token: "s1" } }),
    });

    await storage.warm("session");

    expect(storage.get("session")).toBeNull();
  });
});

describe("createOfficeStorageAdapter — writes", () => {
  it("writes through to every available backend", async () => {
    const local = fakeLocal();
    const officeRuntime = fakeOfficeRuntime();
    const storage = createOfficeStorageAdapter({ local, officeRuntime });

    storage.set("session", "s1");
    await flush();

    expect(storage.get("session")).toBe("s1");
    expect(local.getItem("session")).toBe("s1");
    await expect(officeRuntime.getItem("session")).resolves.toBe("s1");
  });

  it("clears every backend on remove", async () => {
    const local = fakeLocal({ session: "s1" });
    const officeRuntime = fakeOfficeRuntime({ session: "s1" });
    const storage = createOfficeStorageAdapter({ local, officeRuntime });
    await storage.warm("session");

    storage.remove("session");
    await flush();

    expect(storage.get("session")).toBeNull();
    expect(local.getItem("session")).toBeNull();
    await expect(officeRuntime.getItem("session")).resolves.toBeNull();
  });
});

describe("createOfficeStorageAdapter — degraded backends", () => {
  it("keeps serving from memory when the local write throws", () => {
    // Quota, or Safari private mode. The session must survive the current run
    // even though it will not survive the reload.
    const local = fakeLocal();
    vi.spyOn(local, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const onDiagnostic = vi.fn();
    const storage = createOfficeStorageAdapter({ local, onDiagnostic });

    expect(() => storage.set("session", "s1")).not.toThrow();
    expect(storage.get("session")).toBe("s1");
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/Local storage write failed/),
      expect.any(DOMException),
    );
  });

  it("does not surface a rejected mirror write to the caller", async () => {
    const officeRuntime = fakeOfficeRuntime();
    vi.spyOn(officeRuntime, "setItem").mockRejectedValue(new Error("OfficeRuntime unavailable"));
    const onDiagnostic = vi.fn();
    const storage = createOfficeStorageAdapter({ local: fakeLocal(), officeRuntime, onDiagnostic });

    storage.set("session", "s1");
    await flush();

    expect(storage.get("session")).toBe("s1");
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/OfficeRuntime\.storage\.setItem failed/),
      expect.any(Error),
    );
  });

  it("falls through to the next backend when a read throws", async () => {
    const local = fakeLocal();
    vi.spyOn(local, "getItem").mockImplementation(() => {
      throw new Error("blocked by policy");
    });
    const onDiagnostic = vi.fn();
    const storage = createOfficeStorageAdapter({
      local,
      officeRuntime: fakeOfficeRuntime({ session: "s1" }),
      onDiagnostic,
    });

    await storage.warm("session");

    expect(storage.get("session")).toBe("s1");
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/Local storage read failed/),
      expect.any(Error),
    );
  });

  it("survives with no optional backend and no diagnostic sink", async () => {
    const storage = createOfficeStorageAdapter({ local: fakeLocal() });
    await expect(storage.warm("session")).resolves.toBeUndefined();
    expect(() => storage.remove("session")).not.toThrow();
  });
});
