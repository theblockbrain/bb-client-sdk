import type { SyncStorageAdapter } from "./storage.js";

/**
 * A {@link SyncStorageAdapter} over a Web Storage area (`localStorage` /
 * `sessionStorage`).
 *
 * The area is a parameter, never read from a global here: this module is reachable
 * from the framework-agnostic core, and dereferencing `localStorage` at import
 * time is what breaks Node and React Native (invariant B). Browser-only callers
 * pass the global in at the call site, where it is safe.
 *
 * A pass-through, so the stored bytes are unchanged from a direct
 * `localStorage.setItem` — existing values keep reading, and anything else
 * sharing the key (a pre-paint theme script) keeps working.
 */
export function createWebStorageAdapter(area: Storage): SyncStorageAdapter {
  return {
    get: (key: string): string | null => area.getItem(key),
    set: (key: string, value: string): void => {
      area.setItem(key, value);
    },
    remove: (key: string): void => {
      area.removeItem(key);
    },
  };
}
