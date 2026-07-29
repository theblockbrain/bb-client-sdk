/**
 * Cookiebot binding — `@theblockbrain/bb-client-sdk/telemetry/cookiebot`.
 *
 * The web app's {@link ConsentSource}. An opt-in leaf, like
 * `./analytics/mixpanel`: the core telemetry module stays DOM-free and
 * provider-agnostic, and this file is the only place that knows what Cookiebot is.
 *
 * NO DOM DEPENDENCY: {@link CookiebotLike} and {@link ConsentEventTarget} are
 * STRUCTURAL types describing the two things we read. The caller passes
 * `window.Cookiebot` and `window`. A test double satisfies them just as well, so
 * this compiles and runs in Node.
 *
 * WHY THE SDK GATES RATHER THAN COOKIEBOT: Cookiebot's automatic blocking works by
 * rewriting raw `<script src>` tags to `type="text/plain"` and re-running them
 * after consent. Mixpanel in a bundled SPA is an imported npm module, not a script
 * tag, so auto-blocking does not stop it — Cookiebot's own support calls
 * auto-blocking "not advisable" for single-bundle scripts. Cookiebot therefore
 * supplies the SIGNAL and our adapter is the actual gate.
 *
 * WHY THE STATISTICS CATEGORY SPECIFICALLY: a user can accept Marketing and
 * decline Statistics. Branching on "did they accept anything" would treat a
 * refusal of analytics as permission to do analytics, which is the substantive
 * failure this whole gate exists to prevent.
 */

import type { ConsentSource, ConsentState } from "./consent.js";

/** The Cookiebot consent categories we read. Only `statistics` gates analytics. */
export interface CookiebotConsent {
  necessary?: boolean;
  preferences?: boolean;
  statistics?: boolean;
  marketing?: boolean;
}

/** The subset of the Cookiebot global this module touches. */
export interface CookiebotLike {
  consent?: CookiebotConsent;
  /**
   * True once the user has actually answered. Cookiebot exposes this; when it is
   * absent we fall back to whether a `consent` object exists at all.
   */
  hasResponse?: boolean;
}

/** The `addEventListener` / `removeEventListener` pair we need from `window`. */
export interface ConsentEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * The Cookiebot lifecycle events worth listening to.
 *
 * `OnConsentReady` is the one people forget: it fires for a RETURNING visitor
 * whose decision already exists, where neither `OnAccept` nor `OnDecline` will
 * fire. Miss it and consent silently reads as `unknown` for everyone who already
 * answered, so analytics never starts for your existing users.
 *
 * `OnDecline` matters because withdrawal must be as easy as giving it
 * (GDPR Art. 7(3)) — a gate that only ever opens is not a gate.
 */
export const COOKIEBOT_EVENTS = [
  "CookiebotOnConsentReady",
  "CookiebotOnAccept",
  "CookiebotOnDecline",
] as const;

export interface CookiebotSourceOptions {
  /**
   * How to reach the Cookiebot global. A GETTER, not the object, because the
   * Cookiebot script loads asynchronously and is usually absent when our module
   * initialises. Passing the object once would pin `undefined` forever and the
   * gate would never open. Pass `() => window.Cookiebot`.
   */
  getCookiebot: () => CookiebotLike | undefined;
  /** Where the lifecycle events fire. Pass `window`. */
  target: ConsentEventTarget;
}

/**
 * Map Cookiebot's state onto a {@link ConsentState}.
 *
 * Script not loaded yet, or loaded but unanswered, is `unknown` — the banner
 * should show and nothing should emit. Answered-without-Statistics is `denied`.
 */
function toConsentState(cookiebot: CookiebotLike | undefined): ConsentState {
  if (!cookiebot) return "unknown";

  const consent = cookiebot.consent;
  if (!consent) return "unknown";

  // `hasResponse` is authoritative when present. Without it, the presence of a
  // consent object means Cookiebot has resolved a decision.
  if (cookiebot.hasResponse === false) return "unknown";

  return consent.statistics === true ? "granted" : "denied";
}

/**
 * Build the web app's consent source.
 *
 * Wire it into a gate and hand the gate to the analytics adapter:
 *
 * ```ts
 * const source = createCookiebotConsentSource({
 *   getCookiebot: () => window.Cookiebot,
 *   target: window,
 * });
 * const gate = createConsentGate(source);
 * ```
 *
 * Reads through to the global on every query, so a Cookiebot script that arrives
 * after this source is constructed is picked up rather than missed.
 */
export function createCookiebotConsentSource(options: CookiebotSourceOptions): ConsentSource {
  const { getCookiebot, target } = options;

  return {
    getState(): ConsentState {
      try {
        return toConsentState(getCookiebot());
      } catch {
        // A getter that throws (a locked-down iframe, say) is not consent.
        return "denied";
      }
    },
    subscribe(onChange): () => void {
      const handler = (): void => {
        onChange();
      };
      const attached: string[] = [];
      for (const event of COOKIEBOT_EVENTS) {
        try {
          target.addEventListener(event, handler);
          attached.push(event);
        } catch {
          // Keep going: a partially attached listener set still beats none.
        }
      }
      return () => {
        for (const event of attached) {
          try {
            target.removeEventListener(event, handler);
          } catch {
            // Teardown must not throw.
          }
        }
      };
    },
  };
}
