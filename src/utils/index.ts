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
 * checked from here. Confirm those two, then delete it: `createRefreshGuard` in
 * `./auth` already covers the in-flight-dedupe case the SDK actually has, and an
 * unused concurrency primitive is public surface with no consumer. The subpath
 * itself now stays either way — `createStreamCoalescer` has consumers.
 *
 * What belongs here, so the name does not start attracting everything again: a
 * host-agnostic primitive with **no** dependency, no DOM, no network, no auth,
 * and no domain of its own. Anything that parses model output goes to `./text`,
 * anything that talks to a host goes behind an adapter port.
 */
export {
  EXTENSION_TO_FILE_ICON,
  FILE_ICON_FALLBACK,
  getFileIconName,
} from "./file-type-icon.js";
export { createLock } from "./lock.js";
export type { StreamCoalescer, StreamCoalescerConfig } from "./stream-coalescer.js";
export { createStreamCoalescer } from "./stream-coalescer.js";
