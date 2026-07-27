/**
 * Mixpanel adapter — the product-analytics implementation of {@link AnalyticsAdapter},
 * shipped IN the SDK as an opt-in leaf (`@theblockbrain/bb-client-sdk/analytics/mixpanel`).
 *
 * Why it lives here and not in every surface: the taxonomy, identity model, and
 * PII rules are identical across surfaces, so the SDK owns them once ("thin
 * surface, thick SDK"). A surface just installs `mixpanel-browser`, inits it,
 * and hands the instance to {@link createMixpanelAdapter} — then registers the
 * result with `setAnalyticsAdapter`.
 *
 * Zero new SDK dependency: `MixpanelClient` is a STRUCTURAL type describing the
 * `mixpanel-browser` methods we call, so the SDK never imports `mixpanel-browser`
 * (the core stays provider-agnostic — invariant A). A real `mixpanel` instance
 * satisfies it; so does a test double.
 */

import type {
  AnalyticsAdapter,
  AnalyticsErrorContext,
  AnalyticsEventName,
  AnalyticsEventProps,
  AnalyticsIdentity,
} from "../adapters/analytics.js";

/**
 * The subset of the `mixpanel-browser` API this adapter uses, typed structurally
 * so the SDK needs no dependency on Mixpanel. A real `mixpanel` instance (from
 * `mixpanel-browser`) matches this shape.
 */
export interface MixpanelClient {
  track(event: string, properties?: Record<string, unknown>): void;
  identify(distinctId: string): void;
  register(props: Record<string, unknown>): void;
  set_group?(groupKey: string, groupId: string): void;
}

/** Super-properties attached to every event — the dashboard slices on these. */
export interface MixpanelSuperProps {
  /** e.g. "outlook-addin", "word-addin", "web-component". */
  surface: string;
  env: "dev" | "prod";
  sdk_version?: string;
  app_version?: string;
  /** "owa" | "desktop-win" | "desktop-mac" | "ios" | "android" | … */
  host?: string;
}

export interface MixpanelAdapterConfig {
  /** Consent / opt-out gate. When `false`, every method is a silent no-op. */
  enabled?: boolean;
  /** Super-properties registered once and sent with every event. */
  superProps: MixpanelSuperProps;
  /** Group key for tenant roll-up (Mixpanel Group Analytics). Default `tenant_id`. */
  groupKey?: string;
}

/**
 * Belt-and-braces PII/secret denylist — the SECOND line of defence, not the first.
 *
 * The primary control is the typed taxonomy: `AnalyticsEventMap` is a closed,
 * PII-free set of primitive-valued props, and `AnalyticsErrorContext` restricts
 * values to primitives. This list is the backstop for a stray field arriving from
 * an untyped (plain-JS) caller. It is NOT a guarantee: matching is normalized but
 * still name-based, so a caller determined to send `userMail` will succeed. Callers
 * must not pass PII — see the contract in `../adapters/analytics.ts`.
 */
/**
 * Entries are already normalized (lowercased, separators stripped) and matched
 * EXACTLY against a normalized key. Exact rather than substring matching is
 * deliberate: `statusCode` normalizes to `statuscode` and `error_name` to
 * `errorname`, both of which a substring rule against `code`/`name` would silently
 * drop — taking the `api_error` and `sdk_error` payloads with them.
 */
const PII_DENYLIST = new Set([
  "email",
  "mail",
  "useremail",
  "name",
  "username",
  "givenname",
  "familyname",
  "firstname",
  "lastname",
  "fullname",
  "displayname",
  "phone",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "bearer",
  "authorization",
  "password",
  "secret",
  "clientsecret",
  "apikey",
  "cookie",
  "sessionid",
  "code",
  "codeverifier",
  "verifier",
  "state",
  "responsebody",
  "body",
  "message",
  "stack",
]);

/** Lowercase and strip separators so `Access_Token`, `access-token` and `accessToken` all match. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

/**
 * Keep only JSON-safe primitives whose normalized key is not denylisted.
 *
 * An allowlist (`string | number | boolean`) rather than a "not an object" test,
 * for two reasons:
 *
 * 1. **Nothing object-shaped can leak.** The taxonomy is primitives-only by design,
 *    so a nested value is always a caller error — and dropping it means a
 *    `BBApiError`, a response body, or any object graph carrying a token can never
 *    be forwarded, whatever key it arrived under.
 * 2. **One bad field must not cost the whole event.** `bigint` and `symbol` are
 *    primitives but not JSON-safe: `JSON.stringify` THROWS on a bigint and silently
 *    omits a symbol. Mixpanel serializes the payload, so a single stray bigint from
 *    an untyped caller would throw inside `mixpanel.track`, get swallowed by the
 *    adapter's catch, and take the entire event with it. Dropping the one field is
 *    strictly better than losing the event.
 *
 * `null`/`undefined` and functions fall out of the same check for free.
 */
function scrub(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    const type = typeof v;
    if (type !== "string" && type !== "number" && type !== "boolean") continue;
    if (PII_DENYLIST.has(normalizeKey(k))) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build an {@link AnalyticsAdapter} backed by a Mixpanel-shaped client.
 *
 * @example
 * ```ts
 * import mixpanel from "mixpanel-browser";
 * import { setAnalyticsAdapter } from "@theblockbrain/bb-client-sdk/analytics";
 * import { createMixpanelAdapter } from "@theblockbrain/bb-client-sdk/analytics/mixpanel";
 *
 * mixpanel.init(MIXPANEL_TOKEN, { api_host: "https://api-eu.mixpanel.com", ip: false });
 * setAnalyticsAdapter(
 *   createMixpanelAdapter(mixpanel, { superProps: { surface: "outlook-addin", env: "prod" } }),
 * );
 * ```
 */
export function createMixpanelAdapter(
  mixpanel: MixpanelClient,
  config: MixpanelAdapterConfig,
): AnalyticsAdapter {
  const enabled = config.enabled ?? true;
  const groupKey = config.groupKey ?? "tenant_id";

  if (enabled) {
    try {
      mixpanel.register(scrub({ ...config.superProps }));
    } catch {
      /* never throw out of setup */
    }
  }

  return {
    track<K extends AnalyticsEventName>(
      event: K,
      props: AnalyticsEventProps<K>,
      identity?: AnalyticsIdentity,
    ): void {
      if (!enabled) return;
      try {
        mixpanel.track(
          event,
          scrub({
            ...(props as Record<string, unknown>),
            // Identity is derived, so it is spread LAST and wins over any
            // same-named caller prop.
            ...(identity?.distinctId ? { distinct_id: identity.distinctId } : {}),
            ...(identity?.orgId ? { [groupKey]: identity.orgId } : {}),
          }),
        );
      } catch {
        /* MUST NOT throw — the adapter contract holds even off the sink's path */
      }
    },

    captureError(error: unknown, context?: AnalyticsErrorContext): void {
      if (!enabled) return;
      // Errors are Sentry's job; drop a PII-free breadcrumb into Mixpanel so error
      // volume sits next to usage. Only the error NAME + scrubbed context — never
      // the message/stack/responseBody.
      const name = error instanceof Error ? error.name : "Error";
      const { distinctId, orgId, ...rest } = context ?? {};
      try {
        mixpanel.track(
          "sdk_error",
          // `rest` FIRST so the derived fields below win — a caller-supplied
          // `error_name` or `tenant_id` must not override the real ones.
          scrub({
            ...rest,
            error_name: name,
            ...(distinctId ? { distinct_id: distinctId } : {}),
            ...(orgId ? { [groupKey]: orgId } : {}),
          }),
        );
      } catch {
        /* MUST NOT throw */
      }
    },

    identify(distinctId: string): void {
      if (!enabled) return;
      try {
        mixpanel.identify(distinctId); // Zitadel `sub` — pseudonymous, never PII
      } catch {
        /* MUST NOT throw */
      }
    },

    group(orgId: string): void {
      if (!enabled) return;
      try {
        mixpanel.register({ [groupKey]: orgId });
        mixpanel.set_group?.(groupKey, orgId);
      } catch {
        /* MUST NOT throw */
      }
    },
  };
}
