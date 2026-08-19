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
 *   The sink guards the calls it makes (`trackEvent`/`captureError`/`trackApiError`/
 *   `flushAnalytics`); direct `identify`/`group` calls are not — a throwing adapter is a defect.
 * - NEVER send PII or secrets. Identify users by the Zitadel `sub`
 *   (pseudonymous); group by org id. Never pass access/refresh tokens, emails,
 *   names, or raw `BBApiError.responseBody`.
 */

import type { CoreEventMap, CoreEventName, CoreEventProps } from "../telemetry/taxonomy.js";

/** Stable, pseudonymous identity attached to events. Never PII. */
export interface AnalyticsIdentity {
  /** Zitadel `sub` claim — a stable pseudonymous user id (never an email/name). */
  distinctId?: string;
  /** Home org id (tenant) — the analytics "group". */
  orgId?: string;
}

/**
 * The standard SDK event taxonomy — **one** vocabulary, defined in
 * {@link CoreEventMap} (`./telemetry`).
 *
 * This used to be a second, independently-declared map (`auth_success`,
 * `message_send`, `stream_start`, camelCase props). Two vocabularies for the same
 * concepts is a dashboard-breaking trap: whichever a surface happens to emit
 * becomes the query keys of every panel and burn-rate rule built on it, and the
 * two cannot both be right. `CoreEventMap` wins for three concrete reasons:
 *
 * 1. **Its property names are legal, conventional Prometheus labels.** Metric and
 *    label names match `[a-zA-Z_][a-zA-Z0-9_]*`, so `status_code` / `ttft_ms` /
 *    `latency_ms` sit beside the platform's existing series while `statusCode` /
 *    `latencyMs` read as foreign in every PromQL query written against them.
 * 2. **It carries `route`** (the shared client/backend vocabulary) rather than a
 *    SDK-private `backend: "blocky" | "agentic"`, so a panel can slice the same
 *    way the retrieval dashboards already do.
 * 3. **It cannot silently drift** — {@link CORE_EVENT_NAMES} is proved exhaustive
 *    against the map at compile time, and it ships with the consent gate and PII
 *    denylist that the release gate assumes.
 *
 * @deprecated Prefer `CoreEventMap` from `@theblockbrain/bb-client-sdk/telemetry`.
 * Retained as an alias so type references written against `0.18.0` keep resolving.
 */
export type AnalyticsEventMap = CoreEventMap;

export type AnalyticsEventName = CoreEventName;
export type AnalyticsEventProps<K extends AnalyticsEventName> = CoreEventProps<K>;

/**
 * Extra context for `captureError`. Keep it PII/secret-free. Values are
 * restricted to primitives so whole objects (e.g. raw response bodies) can't
 * be attached by accident.
 */
export interface AnalyticsErrorContext extends AnalyticsIdentity {
  /** Coarse tag for where the error happened, e.g. "auth", "stream", "api". */
  scope?: string;
  [key: string]: string | number | boolean | null | undefined;
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
