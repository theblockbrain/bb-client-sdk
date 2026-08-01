/**
 * General-purpose primitives — `./utils`.
 *
 * PDEV-7684 emptied this out: the text helpers became `./text`, and the JWT
 * decoder folded into `./auth`. `createLock` is what genuinely did not belong in
 * either, so it stayed.
 *
 * ⚠️ `createLock` has **no caller** — not in this SDK, not in `ms-outlook-addin`,
 * not in `b2b-webcomponents`. It was kept rather than deleted only because
 * `bb-academy` and `bb-batch-analyzer` also install this package and could not be
 * checked from here. Confirm those two, then delete it and this subpath with it:
 * `createRefreshGuard` in `./auth` already covers the in-flight-dedupe case the
 * SDK actually has, and an unused concurrency primitive is public surface with no
 * consumer.
 */
export { createLock } from "./lock.js";
