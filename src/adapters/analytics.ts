/**
 * AnalyticsAdapter — the telemetry injection seam.
 *
 * A peer of {@link StorageAdapter} and {@link IdentityAdapter}: each surface
 * implements it once and registers it via `setAnalyticsAdapter` (from
 * `@theblockbrain/bb-client-sdk/analytics`). The SDK then emits a standard,
 * typed event taxonomy through it, which the surface forwards to Mixpanel
 * (product analytics) and Sentry (crash/error) — the two halves of the domain's
 * "instrument every surface" release gate.
 *
 * Contract:
 * - Implementations MUST NOT throw and SHOULD be non-blocking (fire-and-forget).
 *   The sink guards every call too, but a throwing adapter is a defect.
 * - NEVER send PII or secrets. Identify users by the Zitadel `sub`
 *   (pseudonymous); group by org id. Never pass access/refresh tokens, emails,
 *   names, or raw `BBApiError.responseBody`.
 */

/** Stable, pseudonymous identity attached to events. Never PII. */
export interface AnalyticsIdentity {
  /** Zitadel `sub` claim — a stable pseudonymous user id (never an email/name). */
  distinctId?: string;
  /** Home org id (tenant) — the analytics "group". */
  orgId?: string;
}

/**
 * The standard SDK event taxonomy. Keys are event names; values are the
 * (PII-free) property shape for that event. Extend deliberately — every surface
 * and dashboard depends on these names staying stable.
 */
export interface AnalyticsEventMap {
  auth_started: { mode: "oauth" | "api-key" };
  auth_success: { mode: "oauth" | "api-key"; latencyMs?: number };
  /** `stage` is a coarse phase label ("launch" | "parse" | "exchange") — never error detail. */
  auth_failed: { mode: "oauth" | "api-key"; stage?: string };
  token_refresh: { ok: boolean; latencyMs?: number };
  message_send: { conversationId?: string; backend?: "blocky" | "agentic"; streaming: boolean };
  stream_start: { backend?: "blocky" | "agentic" };
  stream_first_token: { backend?: "blocky" | "agentic"; latencyMs?: number };
  stream_complete: { backend?: "blocky" | "agentic"; durationMs?: number };
  stream_dropped: { backend?: "blocky" | "agentic"; reason?: string };
  stream_reconnect: { backend?: "blocky" | "agentic"; attempt: number };
  /** HTTP failure. NEVER include the response body — scrub to status + endpoint. */
  api_error: { statusCode: number; endpoint?: string; method?: string };
}

export type AnalyticsEventName = keyof AnalyticsEventMap;
export type AnalyticsEventProps<K extends AnalyticsEventName> = AnalyticsEventMap[K];

/** Extra context for `captureError`. Keep it PII/secret-free. */
export interface AnalyticsErrorContext extends AnalyticsIdentity {
  /** Coarse tag for where the error happened, e.g. "auth", "stream", "api". */
  scope?: string;
  [key: string]: unknown;
}

export interface AnalyticsAdapter {
  /**
   * Record a product event (→ Mixpanel). Fire-and-forget.
   * Implementations MUST NOT throw.
   */
  track<K extends AnalyticsEventName>(
    event: K,
    props: AnalyticsEventProps<K>,
    identity?: AnalyticsIdentity,
  ): void;

  /**
   * Record an error/crash (→ Sentry). Never pass tokens or PII in `context`,
   * and never forward `BBApiError.responseBody` raw.
   */
  captureError(error: unknown, context?: AnalyticsErrorContext): void;

  /** Associate the current user (Zitadel `sub`). Optional. */
  identify?(distinctId: string, traits?: Readonly<Record<string, string | number | boolean>>): void;

  /** Associate the current tenant/org as a group. Optional. */
  group?(orgId: string, traits?: Readonly<Record<string, string | number | boolean>>): void;

  /** Flush buffered events (e.g. before unload / process exit). Optional. */
  flush?(): Promise<void> | void;
}
