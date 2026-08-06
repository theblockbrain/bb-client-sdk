/**
 * Message keys (L12).
 *
 * The SDK owns the **vocabulary**, not the strings. Every user-facing message it
 * produces has a stable key; each surface maps keys to its own translations. That
 * split is deliberate: shipping catalogues would put product copy and locale data
 * in a package consumed by five surfaces with different tones and release cadences,
 * while shipping nothing at all lets each surface invent its own keys for the same
 * condition — which is how three copies of the same status ladder appeared in one
 * Outlook file.
 *
 * A closed union rather than `string`, so `Record<BBMessageKey, string>` makes a
 * missing translation a compile error in the surface rather than a blank label in
 * production. Adding a key here is therefore a deliberate, visible change.
 */
export type BBMessageKey =
  // Request failures — the keys `describeBBApiError` attaches.
  | "error.unknown"
  | "error.offline"
  | "error.timeout"
  | "error.cancelled"
  | "error.badResponse"
  | "error.signedOut"
  | "error.forbidden"
  | "error.notFound"
  | "error.rateLimited"
  | "error.server"
  | "error.rejected"
  // Device capture — the keys `describeMediaCaptureError` attaches (`./media`).
  // Here rather than in each add-in's own key space because the condition is the
  // SDK's to detect: two surfaces had already written the same three-branch
  // `DOMException.name` ladder, and a third was about to.
  | "media.permissionDenied"
  | "media.deviceNotFound"
  | "media.captureFailed";

/** Every key, for a surface that wants to assert its catalogue is complete. */
export const BB_MESSAGE_KEYS = [
  "error.unknown",
  "error.offline",
  "error.timeout",
  "error.cancelled",
  "error.badResponse",
  "error.signedOut",
  "error.forbidden",
  "error.notFound",
  "error.rateLimited",
  "error.server",
  "error.rejected",
  "media.permissionDenied",
  "media.deviceNotFound",
  "media.captureFailed",
] as const satisfies readonly BBMessageKey[];

/** Declared in the union but missing from {@link BB_MESSAGE_KEYS}. Must be `never`. */
type MissingFromList = Exclude<BBMessageKey, (typeof BB_MESSAGE_KEYS)[number]>;
/** Listed but not in the union. Must be `never`. */
type NotInUnion = Exclude<(typeof BB_MESSAGE_KEYS)[number], BBMessageKey>;

/**
 * Compile-time proof the union and the list agree — the same guard the telemetry
 * taxonomy uses. If either side gains an entry the other lacks, this stops
 * type-checking rather than drifting silently.
 */
export type MessageKeyListIsComplete = [MissingFromList, NotInUnion] extends [never, never]
  ? true
  : never;
