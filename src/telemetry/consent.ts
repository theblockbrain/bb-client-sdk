/**
 * The consent gate — one contract, six surfaces, six different consent UIs.
 *
 * The KR 2.1 standard (PDEV-7011) settled that analytics may only emit after
 * valid prior consent, but deliberately did NOT settle a single mechanism,
 * because the surfaces are not alike:
 *
 * - **web app** shows a Cookiebot banner and reads its Statistics category.
 * - **web component** must show NO banner of its own. It is embedded in the
 *   customer's SharePoint or Teams page, which has its own CMP and whose owner is
 *   the controller of that page, so the host passes consent in.
 * - **Outlook / Word add-ins** use a one-time first-run screen plus a settings
 *   toggle. A recurring banner in a 320px taskpane is unusable.
 * - **mobile** uses a first-run screen plus a settings toggle.
 * - **Slack / server-side** is not gated by this at all: with no device storage
 *   there is no ePrivacy Art. 5(3) trigger, and it needs its own legal basis.
 *
 * What they share is the DECISION, not the UI. So this module owns the state
 * machine and each surface plugs in a {@link ConsentSource}.
 *
 * TWO INVARIANTS, both deliberate:
 *
 * 1. **Fail closed.** No source, a source that throws, or a source that has not
 *    answered yet all resolve to "do not emit". Absence of consent is not
 *    consent, and `unknown` is not permission.
 * 2. **DOM-free.** This module touches no browser global, so it is safe in React
 *    Native and in Node. The Cookiebot binding lives in `./cookiebot.ts` and is
 *    typed structurally, exactly as `MixpanelClient` avoids a `mixpanel-browser`
 *    dependency.
 */

/**
 * Whether analytics may emit.
 *
 * `unknown` is distinct from `denied` on purpose. Both block emission, but a
 * surface needs to tell them apart: `unknown` means nobody has been asked yet, so
 * show the banner; `denied` means they were asked and said no, so do not ask
 * again. Collapsing the two produces a banner that reappears forever.
 */
export type ConsentState = "granted" | "denied" | "unknown";

/**
 * Where a surface's consent decision comes from.
 *
 * Implementations must not throw from either method — {@link createConsentGate}
 * guards them anyway and treats a fault as `denied`, but a throwing source is a
 * defect.
 */
export interface ConsentSource {
  /** The current decision. Called on demand, never cached by the gate. */
  getState(): ConsentState;
  /**
   * Register for changes. Returns an unsubscribe function.
   *
   * Optional: a source whose value cannot change after construction (a host that
   * passes a fixed boolean, say) can omit it.
   */
  subscribe?(onChange: () => void): () => void;
}

/** The gate a surface hands to its analytics adapter. */
export interface ConsentGate {
  /** The current decision, or `denied` if the source faulted. */
  state(): ConsentState;
  /**
   * Whether analytics may emit right now. True only for `granted` — never for
   * `unknown`, because no answer is not a yes.
   */
  isAllowed(): boolean;
  /**
   * Observe changes. Fires only on an ACTUAL transition, so a CMP that
   * re-broadcasts the same decision on every page view does not cause repeated
   * opt-in calls downstream.
   *
   * Returns an unsubscribe function.
   */
  subscribe(listener: (state: ConsentState) => void): () => void;
  /** Detach from the source and drop all listeners. Idempotent. */
  dispose(): void;
}

/** Read a source without letting a faulty implementation escape. */
function readState(source: ConsentSource | undefined): ConsentState {
  if (!source) return "denied";
  try {
    const state = source.getState();
    // Guard against a source returning something outside the union at runtime.
    return state === "granted" || state === "denied" || state === "unknown" ? state : "denied";
  } catch {
    // A broken consent source must not become permission to track.
    return "denied";
  }
}

/**
 * Build a gate over a {@link ConsentSource}.
 *
 * Pass no source to get a permanently-denied gate. That is the correct default
 * for a surface that has not wired consent yet: it makes the analytics sink a
 * silent no-op rather than an unlawful emitter, and it means "we forgot to wire
 * consent" fails safe instead of failing open.
 */
export function createConsentGate(source?: ConsentSource): ConsentGate {
  const listeners = new Set<(state: ConsentState) => void>();
  let last = readState(source);
  let disposed = false;
  let unsubscribeSource: (() => void) | undefined;

  const onSourceChange = (): void => {
    if (disposed) return;
    const next = readState(source);
    if (next === last) return; // Only real transitions propagate.
    last = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // One bad listener must not stop the others from being told.
      }
    }
  };

  if (source?.subscribe) {
    try {
      unsubscribeSource = source.subscribe(onSourceChange);
    } catch {
      // A source that cannot be subscribed to still reports via getState().
    }
  }

  return {
    state(): ConsentState {
      if (disposed) return "denied";
      // Read through rather than returning the cached value: a source without
      // `subscribe` (a host-supplied getter, say) can change without telling us,
      // and a stale `granted` is the one answer we must never give.
      last = readState(source);
      return last;
    },
    isAllowed(): boolean {
      return this.state() === "granted";
    },
    subscribe(listener): () => void {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      try {
        unsubscribeSource?.();
      } catch {
        // Teardown must not throw.
      }
    },
  };
}

/**
 * A source with a fixed decision.
 *
 * The web component's contract: the host page owns the CMP, so it hands us a
 * boolean and we do not render a banner. Also the natural shape for tests.
 */
export function createStaticConsentSource(state: ConsentState): ConsentSource {
  return { getState: () => state };
}

/**
 * A source backed by a value the surface can change — a settings toggle whose
 * value lives in the surface's own storage.
 *
 * The Office add-ins and mobile use this: a one-time first-run screen writes the
 * decision, a settings toggle updates it, and `set` notifies the gate. Starts at
 * `unknown` so the first-run screen shows exactly once.
 */
export function createTogglableConsentSource(initial: ConsentState = "unknown"): {
  source: ConsentSource;
  set: (state: ConsentState) => void;
} {
  let state = initial;
  const subscribers = new Set<() => void>();
  return {
    source: {
      getState: () => state,
      subscribe(onChange) {
        subscribers.add(onChange);
        return () => subscribers.delete(onChange);
      },
    },
    set(next) {
      if (next === state) return;
      state = next;
      for (const notify of [...subscribers]) notify();
    },
  };
}
