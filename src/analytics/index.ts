/**
 * Analytics sink — the runtime side of the {@link AnalyticsAdapter} seam.
 *
 * A single process-wide adapter is registered once at startup
 * (`setAnalyticsAdapter`). The SDK emits events through the safe `trackEvent` /
 * `captureError` helpers, which no-op when no adapter is registered and NEVER
 * throw or reject into the caller — telemetry must not be able to break a
 * product flow. Per-event identity is passed explicitly, so a single sink is
 * safe in a multi-tenant Node backend (e.g. Slack) serving many orgs — provided
 * that backend's adapter omits the optional, process-wide `identify`/`group`
 * (see {@link identifyUser}).
 *
 * Framework-agnostic and DOM-free (invariants A + B): this module imports only
 * types, so `./analytics` is safe for React add-ins, a Lit web component, React
 * Native, and a Node backend alike.
 */

import type {
  AnalyticsAdapter,
  AnalyticsErrorContext,
  AnalyticsEventName,
  AnalyticsEventProps,
  AnalyticsIdentity,
} from "../adapters/analytics.js";

export type {
  AnalyticsAdapter,
  AnalyticsErrorContext,
  AnalyticsEventMap,
  AnalyticsEventName,
  AnalyticsEventProps,
  AnalyticsIdentity,
} from "../adapters/analytics.js";

export type { CompositeChild } from "./composite.js";
export { createCompositeAdapter } from "./composite.js";

let current: AnalyticsAdapter | null = null;

/**
 * Register the process-wide analytics adapter. Pass `null` to detach.
 * Call once at surface startup, after your Mixpanel/Sentry clients are ready.
 */
export function setAnalyticsAdapter(adapter: AnalyticsAdapter | null): void {
  current = adapter;
}

/** The currently registered adapter, or `null` when none is set. */
export function getAnalyticsAdapter(): AnalyticsAdapter | null {
  return current;
}

/** Detach any registered adapter. Primarily for tests / teardown. */
export function resetAnalyticsAdapter(): void {
  current = null;
}

/**
 * Emit a typed product event. No-op when no adapter is registered; never throws.
 */
export function trackEvent<K extends AnalyticsEventName>(
  event: K,
  props: AnalyticsEventProps<K>,
  identity?: AnalyticsIdentity,
): void {
  const adapter = current;
  if (!adapter) return;
  try {
    adapter.track(event, props, identity);
  } catch {
    // Telemetry must never break the SDK — swallow adapter faults.
  }
}

/**
 * Bind the current user for all SUBSEQUENT events (→ `adapter.identify`).
 *
 * Per-event identity (the `identity` argument to {@link trackEvent}) only tags
 * the one event it is passed to. Most SDK events carry none, so without this
 * binding a Mixpanel-backed adapter attributes them to the anonymous device id
 * and org roll-up stays empty. `login()` calls this on success; a surface that
 * restores a session from storage (no `login()` call) should call it at startup.
 *
 * Pass the Zitadel `sub` — pseudonymous, never an email or name. No-op when no
 * adapter is registered or the adapter omits the optional `identify`; never throws.
 *
 * **Process-wide.** A multi-tenant server adapter (e.g. Slack, one process for
 * many orgs) must NOT implement `identify`/`group` — it would make the last
 * caller's identity the default for every later event. Such adapters rely on
 * per-event identity instead.
 */
export function identifyUser(distinctId: string): void {
  const adapter = current;
  if (!adapter?.identify) return;
  try {
    adapter.identify(distinctId);
  } catch {
    // Telemetry must never break the SDK.
  }
}

/**
 * Bind the current tenant for all SUBSEQUENT events (→ `adapter.group`).
 *
 * The group counterpart of {@link identifyUser} — see that doc for why the
 * binding is needed, and for the multi-tenant server caveat. No-op when no
 * adapter is registered or the adapter omits the optional `group`; never throws.
 */
export function setAnalyticsGroup(orgId: string): void {
  const adapter = current;
  if (!adapter?.group) return;
  try {
    adapter.group(orgId);
  } catch {
    // Telemetry must never break the SDK.
  }
}

/**
 * Report an error/crash. No-op when no adapter is registered; never throws.
 */
export function captureError(error: unknown, context?: AnalyticsErrorContext): void {
  const adapter = current;
  if (!adapter) return;
  try {
    adapter.captureError(error, context);
  } catch {
    // Telemetry must never break the SDK.
  }
}

/**
 * Convenience: emit an `api_error` event from a caught error. Only the SAFE
 * fields are forwarded — `statusCode` and `endpoint`. The error's `responseBody`
 * is deliberately NEVER sent (it may echo secrets). No-op for errors without a
 * numeric `statusCode` (i.e. not an HTTP failure we can classify).
 *
 * Endpoint/adapter authors call this in a catch block, then re-throw:
 *   catch (err) { trackApiError(err, identity); throw err; }
 */
export function trackApiError(error: unknown, identity?: AnalyticsIdentity): void {
  const e = error as { statusCode?: unknown; endpoint?: unknown } | null;
  const statusCode = typeof e?.statusCode === "number" ? e.statusCode : undefined;
  if (statusCode === undefined) return;
  const endpoint = typeof e?.endpoint === "string" ? e.endpoint : undefined;
  // `status_code`, not `statusCode`: the taxonomy's property names double as
  // Prometheus label names downstream — see the note on `AnalyticsEventMap`.
  trackEvent("api_error", { status_code: statusCode, endpoint }, identity);
}

/**
 * Flush buffered events via the adapter's optional `flush()`. Resolves even when
 * no adapter is registered or it has no `flush`, and never rejects into the caller.
 */
export async function flushAnalytics(): Promise<void> {
  const adapter = current;
  if (!adapter?.flush) return;
  try {
    await adapter.flush();
  } catch {
    // Never reject into the caller.
  }
}
