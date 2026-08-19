/**
 * Fan one event out to several analytics sinks.
 *
 * `setAnalyticsAdapter` registers exactly ONE adapter, but the release gate
 * requires two halves at once — product analytics (Mixpanel) AND health telemetry
 * (Sentry / Faro). Without this, every surface writes the same hand-rolled
 * `{ track: e => { mp.track(e); faro.push(e) } }` object, and every surface gets
 * the isolation subtly wrong in its own way.
 *
 * ─── One failing sink must not silence the others ──────────────────────────────
 *
 * Each child call is guarded INDIVIDUALLY, not the loop. A single `try` around the
 * whole fan-out would mean the first sink to throw swallows every sink after it —
 * so a broken Mixpanel init would silently take Sentry down with it, and the
 * surface would look instrumented while reporting nothing. That is the failure
 * this module exists to prevent, and it is invisible from the outside.
 *
 * ─── `identify` / `group` / `flush` are conditionally present ──────────────────
 *
 * These three are OPTIONAL on {@link AnalyticsAdapter}, and their absence is
 * meaningful: the sink's `identifyUser` / `setAnalyticsGroup` no-op when the
 * adapter omits them, which is exactly how a multi-tenant Node backend (one Slack
 * process, many orgs) avoids making the last caller's identity the process-wide
 * default. So the composite declares each one only when at least one child
 * actually implements it — declaring them unconditionally would turn "omitted, so
 * no-op" into "present, but does nothing", which reads the same at runtime and
 * very differently to anyone checking whether the seam is wired.
 */

import type {
  AnalyticsAdapter,
  AnalyticsErrorContext,
  AnalyticsEventName,
  AnalyticsEventProps,
  AnalyticsIdentity,
} from "../adapters/analytics.js";

/**
 * A child sink. `null`/`undefined` entries are dropped, so a caller can compose
 * conditionally without building the array in two steps:
 *
 * ```ts
 * createCompositeAdapter([mixpanelAdapter, consentGranted ? faroAdapter : null])
 * ```
 */
export type CompositeChild = AnalyticsAdapter | null | undefined;

/** Run one child's method, absorbing any fault so the next child still runs. */
function guard(run: () => void): void {
  try {
    run();
  } catch {
    // A child that throws is a defect in that child. It must not become a defect
    // in every other sink, nor in the product flow that emitted the event.
  }
}

/**
 * Compose several {@link AnalyticsAdapter}s into one.
 *
 * Register the result with `setAnalyticsAdapter`. Ordering is preserved but must
 * not be depended on — sinks are independent and fire-and-forget.
 *
 * @example
 * ```ts
 * setAnalyticsAdapter(
 *   createCompositeAdapter([
 *     createMixpanelAdapter(mixpanel, { superProps }),
 *     createFaroAdapter(faro),
 *   ]),
 * );
 * ```
 */
export function createCompositeAdapter(children: readonly CompositeChild[]): AnalyticsAdapter {
  const sinks = children.filter((c): c is AnalyticsAdapter => c != null);

  const composite: AnalyticsAdapter = {
    track<K extends AnalyticsEventName>(
      event: K,
      props: AnalyticsEventProps<K>,
      identity?: AnalyticsIdentity,
    ): void {
      for (const sink of sinks) guard(() => sink.track(event, props, identity));
    },

    captureError(error: unknown, context?: AnalyticsErrorContext): void {
      for (const sink of sinks) guard(() => sink.captureError(error, context));
    },
  };

  // See the header: presence is part of the contract, so each is attached only
  // when a child can actually service it.
  if (sinks.some(s => typeof s.identify === "function")) {
    composite.identify = (distinctId, traits) => {
      for (const sink of sinks) guard(() => sink.identify?.(distinctId, traits));
    };
  }

  if (sinks.some(s => typeof s.group === "function")) {
    composite.group = (orgId, traits) => {
      for (const sink of sinks) guard(() => sink.group?.(orgId, traits));
    };
  }

  if (sinks.some(s => typeof s.flush === "function")) {
    composite.flush = async (): Promise<void> => {
      // `allSettled`, not `all`: one sink that rejects must not cancel the wait on
      // the others, and this runs at unload/exit where a lost flush is lost data.
      await Promise.allSettled(sinks.map(async sink => sink.flush?.()));
    };
  }

  return composite;
}
