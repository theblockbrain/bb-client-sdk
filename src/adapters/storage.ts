/**
 * Async persistence port. The default for token storage: Office
 * `roamingSettings`, `chrome.storage` and Expo `SecureStore` are all async, so
 * the async shape fits the most hosts. Values are typed because those hosts store
 * structured data natively.
 */
export interface StorageAdapter {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Synchronous persistence port, for callers that cannot await.
 *
 * Not a convenience duplicate of {@link StorageAdapter}. `useTheme` reads the
 * stored mode inside a `useState` initialiser, and zustand's `PersistStorage` is
 * synchronous by contract — a surface given only the async port ends up writing
 * its own storage layer instead of using this one.
 *
 * **String-valued, deliberately.** Web Storage and zustand's `StateStorage` are
 * both string stores, and a generic `<T>` here would force an encoding decision
 * into the port: JSON round-tripping cannot distinguish a stored `"123"` from a
 * stored `123`, and it changes the on-disk format, which breaks anything else
 * reading the same key — a pre-paint theme bootstrap script, for instance.
 * Callers that need structure serialise it themselves, exactly as zustand does.
 *
 * A host with only async storage should implement {@link StorageAdapter} and keep
 * an in-memory mirror for sync reads, rather than blocking.
 */
export interface SyncStorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
