/**
 * createLock — factory that serialises async operations through a promise queue.
 *
 * Useful when concurrent writes to a non-atomic store (e.g. chrome.storage.local)
 * would cause last-write-wins data loss. All mutations go through withLock so each
 * sees the result of the previous one.
 */
export function createLock(): {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
} {
  let queue: Promise<unknown> = Promise.resolve();

  return {
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      // Chain onto the queue; forward both resolve and reject so a failing
      // operation does not permanently stall subsequent enqueued calls.
      const next = queue.then(fn, fn) as Promise<T>;
      queue = next.catch(() => {});
      return next;
    },
  };
}
