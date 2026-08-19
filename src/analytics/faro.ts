/**
 * Grafana Faro adapter — the browser-RUM half of {@link AnalyticsAdapter},
 * shipped as an opt-in leaf (`@theblockbrain/bb-client-sdk/analytics/faro`).
 *
 * The peer of the Mixpanel leaf: Mixpanel answers "are people using it and coming
 * back", Faro answers "is it slow or broken for them". The release gate needs
 * both, and {@link createCompositeAdapter} is what registers them together.
 *
 * Zero new SDK dependency: {@link FaroLike} is a STRUCTURAL type over the four
 * `@grafana/faro-web-sdk` methods used, so the core stays provider-agnostic
 * (invariant A). A real `Faro` instance satisfies it; so does a test double.
 *
 * **Browser surfaces only.** Faro has no React Native support — blocky-mobile
 * fills this slot with Sentry RN plus store vitals instead. Web Vitals, page
 * load and unhandled errors are collected by Faro's own instrumentations, not by
 * this adapter; what this adds is the SDK's typed funnel alongside them, so an
 * `api_error` spike and an LCP regression land in the same place.
 */

import type {
  AnalyticsAdapter,
  AnalyticsErrorContext,
  AnalyticsEventName,
  AnalyticsEventProps,
  AnalyticsIdentity,
} from "../adapters/analytics.js";
import { scrubProps } from "./scrub.js";

/** The `setUser` payload — deliberately narrower than Faro's own. See {@link createFaroAdapter}. */
export interface FaroUser {
  id?: string;
  attributes?: Record<string, string>;
}

/**
 * The subset of the Faro API this adapter uses, typed structurally so the SDK
 * needs no dependency on `@grafana/faro-web-sdk`.
 *
 * Note `pushEvent`'s attributes are `Record<string, string>` — that is Faro's own
 * contract, not a simplification, and it is why {@link toAttributes} exists.
 */
export interface FaroLike {
  api: {
    pushEvent(name: string, attributes?: Record<string, string>, domain?: string): void;
    pushError(error: Error): void;
    setUser?(user: FaroUser): void;
  };
}

export interface FaroAdapterConfig {
  /** Consent / opt-out gate. When `false`, every method is a silent no-op. */
  enabled?: boolean;
  /**
   * Faro event `domain` — the namespace events are grouped under in Grafana.
   * Defaults to `blockbrain`, so SDK events are separable from Faro's own
   * instrumentation events in a single query.
   */
  domain?: string;
  /** Attribute key for tenant roll-up. Default `tenant_id` — matches the Mixpanel leaf. */
  groupKey?: string;
}

const DEFAULT_DOMAIN = "blockbrain";
const DEFAULT_GROUP_KEY = "tenant_id";

/**
 * Coerce a scrubbed property bag to Faro's string-valued attribute map.
 *
 * Faro requires `Record<string, string>`; the taxonomy is primitives. Numbers and
 * booleans are stringified rather than dropped, because they are the measurements
 * — losing `ttft_ms` would leave the event without the only field a latency panel
 * reads. {@link scrubProps} has already removed PII, credentials and anything
 * object-shaped, so everything reaching this loop is safe to stringify.
 */
function toAttributes(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scrubProps(props))) {
    out[key] = String(value);
  }
  return out;
}

/** Faro's `pushError` takes an `Error`; a thrown non-Error still has to be reportable. */
function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  // The value is NOT interpolated into the message — a rejected non-Error is
  // frequently a server payload, and this string reaches a dashboard.
  return new Error("Non-Error value thrown");
}

/**
 * Build an {@link AnalyticsAdapter} backed by a Faro instance.
 *
 * @example
 * ```ts
 * import { initializeFaro } from "@grafana/faro-web-sdk";
 * import { setAnalyticsAdapter } from "@theblockbrain/bb-client-sdk/analytics";
 * import { createFaroAdapter } from "@theblockbrain/bb-client-sdk/analytics/faro";
 * import { createCompositeAdapter } from "@theblockbrain/bb-client-sdk/analytics";
 *
 * const faro = initializeFaro({ url: FARO_COLLECTOR_URL, app: { name: "outlook-addin" } });
 * setAnalyticsAdapter(createCompositeAdapter([mixpanelAdapter, createFaroAdapter(faro)]));
 * ```
 */
export function createFaroAdapter(
  faro: FaroLike,
  config: FaroAdapterConfig = {},
): AnalyticsAdapter {
  const enabled = config.enabled ?? true;
  const domain = config.domain ?? DEFAULT_DOMAIN;
  const groupKey = config.groupKey ?? DEFAULT_GROUP_KEY;

  // Faro's `setUser` REPLACES the user object rather than merging into it, so
  // `identify` and `group` cannot each call it with only their own half — the
  // second call would erase the first. The current value is held here and both
  // fields are re-sent together on every change.
  let userId: string | undefined;
  let orgId: string | undefined;

  const syncUser = (): void => {
    if (!faro.api.setUser) return;
    try {
      faro.api.setUser({
        // Never `email` or `username`, both of which Faro accepts and neither of
        // which the SDK has any business sending.
        ...(userId ? { id: userId } : {}),
        ...(orgId ? { attributes: { [groupKey]: orgId } } : {}),
      });
    } catch {
      /* MUST NOT throw */
    }
  };

  return {
    track<K extends AnalyticsEventName>(
      event: K,
      props: AnalyticsEventProps<K>,
      identity?: AnalyticsIdentity,
    ): void {
      if (!enabled) return;
      try {
        faro.api.pushEvent(
          event,
          toAttributes({
            ...(props as Record<string, unknown>),
            // Derived, so spread last — a caller prop must not shadow real identity.
            ...(identity?.distinctId ? { distinct_id: identity.distinctId } : {}),
            ...(identity?.orgId ? { [groupKey]: identity.orgId } : {}),
          }),
          domain,
        );
      } catch {
        /* MUST NOT throw — the contract holds even off the sink's guarded path */
      }
    },

    captureError(error: unknown, context?: AnalyticsErrorContext): void {
      if (!enabled) return;
      try {
        // Faro's `pushError` carries no free-form context, and that is a good fit
        // here: `scope`/`distinctId`/`orgId` are already on the session via
        // `setUser`, and forwarding the rest risks re-attaching what the taxonomy
        // deliberately keeps off an error. The stack Faro captures is the payload.
        faro.api.pushError(toError(error));
      } catch {
        /* MUST NOT throw */
      }
      void context;
    },

    identify(distinctId: string): void {
      if (!enabled) return;
      userId = distinctId; // Zitadel `sub` — pseudonymous, never PII
      syncUser();
    },

    group(nextOrgId: string): void {
      if (!enabled) return;
      orgId = nextOrgId;
      syncUser();
    },
  };
}
