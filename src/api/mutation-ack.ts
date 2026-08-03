/**
 * The acknowledgement shape returned by the integrations host's `set-*` mutations.
 *
 * Its own module rather than a corner of `agents.ts` (PDEV-7684). It used to live
 * there and `capabilities.ts` imported it across — so capabilities depended on
 * agents for a type neither owns, and a reader looking for the capability
 * response shape had to go read the agents module to find it.
 */

/**
 * `{ ok, error? }` — what `setAgentActive`, `setAgentAvailability`,
 * `setCapabilityActive` and `setCapabilityAvailability` resolve to.
 *
 * Renamed from `ApiResponse`, which was far too broad a name to export from a
 * shared SDK: it claimed the generic concept while describing one specific
 * acknowledgement, so every other endpoint's response had to be named around it.
 *
 * Note this is the *body* of a 2xx. A non-2xx never reaches here — `throwIfNotOk`
 * raises `BBApiError` first — so `ok: false` means the server accepted the request
 * and declined the operation, which is a different thing from a failed call.
 */
export interface MutationAckResponse {
  ok: boolean;
  error?: string;
}
