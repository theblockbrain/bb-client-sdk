import type { SyncStorageAdapter } from "./storage.js";

/**
 * The slice of Web Storage this adapter uses — **structural**, the same approach
 * `OfficeGlobal` takes, so the public signature never names the DOM's ambient
 * `Storage`.
 *
 * Why that matters: naming `Storage` puts a DOM ambient type in the shipped
 * `./adapters` declarations, and a consumer whose `lib` excludes `dom` then fails to
 * typecheck on a declaration it never calls. Node is *not* affected — `@types/node`
 * declares a global `Storage` — but **React Native has neither DOM lib nor
 * `@types/node`**, and it is a first-class target (invariant B, PDEV-7372).
 *
 * A widening, not a break: `localStorage` and `sessionStorage` both satisfy it, so
 * every existing call site keeps compiling. It also lets a test double or an
 * AsyncStorage-style shim be passed without a cast.
 */
export interface WebStorageArea {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

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
export function createWebStorageAdapter(area: WebStorageArea): SyncStorageAdapter {
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
