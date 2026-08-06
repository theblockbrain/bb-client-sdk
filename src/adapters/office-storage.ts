/**
 * Persistence for an Office add-in — the backend priority, and why.
 *
 * This encodes a finding that cost `ms-outlook-addin` a release to diagnose and
 * that every other Office surface is on course to rediscover:
 *
 * **`Office.context.roamingSettings` is not a viable primary store.** Its
 * `saveAsync` round-trips to the mailbox server (`SaveExtensionSettings`), which
 * returns a 500 for *sideloaded* add-ins on the `outlook.cloud.microsoft`
 * backend. The write appears to succeed, nothing is persisted, and the symptom is
 * a user forced to sign in on every open — with no error anywhere near the cause.
 *
 * So the order is:
 *
 * 1. **Web Storage** (`localStorage`) — synchronous and proven to persist in the
 *    task pane. The source of truth.
 * 2. **`OfficeRuntime.storage`** — mirrored to when present. Not universally
 *    available in Outlook on the web, so it cannot lead.
 * 3. **`roamingSettings`** — read once, as a *migration source only*, so an
 *    existing user's data is not stranded. Never written.
 *
 * Reads are synchronous ({@link SyncStorageAdapter}) because zustand's
 * `PersistStorage` is synchronous by contract and a theme bootstrap runs before
 * paint. Backend 2 is async, so {@link OfficeStorageAdapter.warm} pre-loads a key
 * into memory and must be awaited during boot — inside `Office.onReady`, since
 * `OfficeRuntime` does not exist before it.
 */

import type { SyncStorageAdapter } from "./storage.js";
import type { WebStorageArea } from "./web-storage.js";

/** The slice of `OfficeRuntime.storage` used — structural, so no Office.js types. */
export interface OfficeRuntimeStorageArea {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** The slice of `Office.context.roamingSettings` used. Read-only here, by design. */
export interface RoamingSettingsArea {
  get(key: string): unknown;
}

export interface OfficeStorageConfig {
  /** Primary store. Browser callers pass `localStorage`. */
  local: WebStorageArea;
  /**
   * Async mirror, when the host has one. Pass `OfficeRuntime.storage` guarded by
   * a `typeof OfficeRuntime !== "undefined"` check — it is absent in plain
   * browser contexts and in the dialog window.
   */
  officeRuntime?: OfficeRuntimeStorageArea;
  /**
   * One-time migration source. Pass `Office.context.roamingSettings` if this
   * surface ever persisted there. Read during {@link OfficeStorageAdapter.warm},
   * never written.
   */
  roaming?: RoamingSettingsArea;
  /**
   * Where to report a backend failure. Every write is best-effort — losing a
   * mirror must not fail the caller — so without this the failures are silent.
   */
  onDiagnostic?: (message: string, cause?: unknown) => void;
}

export interface OfficeStorageAdapter extends SyncStorageAdapter {
  /**
   * Load `key` from the backends into the in-memory cache that {@link get} reads.
   *
   * Await this during boot, inside `Office.onReady`, **before** any synchronous
   * read. Skipping it is not a cache miss that self-corrects: a zustand store
   * hydrates from an empty cache, decides the user is logged out, and the
   * persisted session is then overwritten by that conclusion.
   */
  warm(key: string): Promise<void>;
}

/**
 * Build an {@link OfficeStorageAdapter}.
 *
 * Writes go to every available backend; reads are served from memory. A failing
 * backend is reported through `onDiagnostic` and otherwise ignored, because a
 * mirror that is unavailable is a degraded mode, not an error the UI can act on.
 */
export function createOfficeStorageAdapter(config: OfficeStorageConfig): OfficeStorageAdapter {
  const { local, officeRuntime, roaming, onDiagnostic } = config;
  const memory = new Map<string, string>();

  const report = (message: string, cause?: unknown): void => {
    onDiagnostic?.(message, cause);
  };

  const mirror = (key: string, value: string): void => {
    if (!officeRuntime) return;
    // Fire-and-forget: the primary write already happened synchronously, and
    // awaiting here would make every `set` async for the benefit of a mirror.
    void officeRuntime.setItem(key, value).catch((err: unknown) => {
      report(`OfficeRuntime.storage.setItem failed for "${key}"`, err);
    });
  };

  const writeThrough = (key: string, value: string): void => {
    try {
      local.setItem(key, value);
    } catch (err) {
      // Quota, or Safari's private mode. Worth reporting: the in-memory value
      // still serves this session, so the failure is invisible until the reload.
      report(`Local storage write failed for "${key}"`, err);
    }
    mirror(key, value);
  };

  return {
    async warm(key: string): Promise<void> {
      // 1. Web Storage — synchronous and authoritative.
      try {
        const value = local.getItem(key);
        if (value) {
          memory.set(key, value);
          mirror(key, value);
          return;
        }
      } catch (err) {
        report(`Local storage read failed for "${key}"`, err);
      }

      // 2. OfficeRuntime.storage — the async mirror, promoted back to primary.
      if (officeRuntime) {
        try {
          const value = await officeRuntime.getItem(key);
          if (value) {
            memory.set(key, value);
            try {
              local.setItem(key, value);
            } catch (err) {
              report(`Local storage backfill failed for "${key}"`, err);
            }
            return;
          }
        } catch (err) {
          report(`OfficeRuntime.storage.getItem failed for "${key}"`, err);
        }
      }

      // 3. roamingSettings — migration only. See the module doc for why it is
      // never written back.
      if (roaming) {
        try {
          const value = roaming.get(key);
          if (typeof value === "string" && value) {
            report(`Migrating "${key}" from roamingSettings to local storage`);
            memory.set(key, value);
            writeThrough(key, value);
          }
        } catch (err) {
          report(`roamingSettings read failed for "${key}"`, err);
        }
      }
    },

    get(key: string): string | null {
      return memory.get(key) ?? null;
    },

    set(key: string, value: string): void {
      memory.set(key, value);
      writeThrough(key, value);
    },

    remove(key: string): void {
      memory.delete(key);
      try {
        local.removeItem(key);
      } catch (err) {
        report(`Local storage remove failed for "${key}"`, err);
      }
      if (officeRuntime) {
        void officeRuntime.removeItem(key).catch((err: unknown) => {
          report(`OfficeRuntime.storage.removeItem failed for "${key}"`, err);
        });
      }
    },
  };
}
