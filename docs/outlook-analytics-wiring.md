# Wiring Mixpanel analytics into ms-outlook-addin (draft)

Copy-paste-ready plan for the **Outlook pilot** (spec §9 Phase 2 · PDEV-7010). This is
the *thin surface* side: the add-in inits Mixpanel, sets identity, and adds the ~4 events
the SDK cannot see. The SDK's own catalog (`auth_*`, `message_send`, `stream_*`,
`api_error`) is the *intended* division of labour — see the second blocker below.

> **Blocker 1 — the subpath.** The add-in must consume an SDK build that exports
> `./analytics` + `./analytics/mixpanel`. Both are on the SDK's `main` but **not in any
> published release** — the newest tag is `v0.17.0` and the add-in pins `^0.17.0`, which
> resolves to it. So this needs **the next release** (`0.18.0`, not cut yet), a **canary**
> build (`npm i @theblockbrain/bb-client-sdk@canary`, published by adding the
> `release:canary` label to an SDK PR), or a local **`file:` link** to a built SDK checkout.
>
> **Blocker 2 — the SDK emits nothing yet.** ⚠️ No SDK call site currently emits through the
> seam: `grep -rn "trackEvent(" src/` in the SDK matches only `src/analytics/` itself. The
> `login()` `auth_*` instrumentation (PDEV-6855) never reached `main` — PR #20 merged into an
> already-merged base branch. So registering an adapter today gives you **only the four surface
> events below**, not the funnel. The min-event-set in §4 and the DoD in §5 cannot be satisfied
> until PDEV-6855 is re-merged and `message_send` / `stream_*` / `api_error` are wired at their
> call sites. Sequence that work before this pilot, or scope the pilot to surface events only.

---

## 1. Install

```bash
npm i mixpanel-browser
npm i -D @types/mixpanel-browser
```

The SDK itself needs nothing added — `createMixpanelAdapter` is typed structurally, so
`mixpanel-browser` is the add-in's dependency, not the SDK's.

## 2. One analytics bootstrap module — `src/analytics.ts` (in the add-in)

```ts
import mixpanel from "mixpanel-browser";
import {
  setAnalyticsAdapter,
  getAnalyticsAdapter,
} from "@theblockbrain/bb-client-sdk/analytics";
import { createMixpanelAdapter } from "@theblockbrain/bb-client-sdk/analytics/mixpanel";

// Build-time constants (wire to your env / manifest).
const MIXPANEL_TOKEN = process.env.MIXPANEL_TOKEN ?? "";
const APP_VERSION = process.env.APP_VERSION ?? "0.0.0";   // Outlook manifest <Version>
const SDK_VERSION = "0.18.0";                              // whatever SDK version you resolve to
const ENV: "dev" | "prod" = process.env.NODE_ENV === "production" ? "prod" : "dev";

/**
 * Map the Office platform to the `host` super-prop.
 * NOTE: `typeof Office === "undefined"` — not `Office?.…` — is required. Optional chaining
 * does NOT protect an *undeclared* global; `Office?.x` still throws ReferenceError if
 * office.js has not loaded. Compare against string literals so the enum is never
 * dereferenced. Telemetry must never throw into task-pane startup.
 */
function officeHost(): string {
  if (typeof Office === "undefined" || !Office.context) return "unknown";
  switch (String(Office.context.platform)) {
    case "PC": return "desktop-win";
    case "Mac": return "desktop-mac";
    case "OfficeOnline": return "owa";
    case "iOS": return "ios";
    case "Android": return "android";
    default: return "unknown";
  }
}

let mp: typeof mixpanel | null = null;

/** Call once at task-pane startup (inside Office.onReady), before any tracking. */
export function initAnalytics(consentGranted: boolean): void {
  if (!MIXPANEL_TOKEN) return; // no token ⇒ safe no-op (dev)

  mixpanel.init(MIXPANEL_TOKEN, {
    api_host: "https://api-eu.mixpanel.com", // EU residency — mandatory (spec §3)
    ip: false,                                // never auto-collect IP/PII
    persistence: "localStorage",
  });
  mp = mixpanel;

  setAnalyticsAdapter(
    createMixpanelAdapter(mixpanel, {
      enabled: consentGranted,                // consent / opt-out gate
      superProps: { surface: "outlook-addin", env: ENV, sdk_version: SDK_VERSION, app_version: APP_VERSION, host: officeHost() },
    }),
  );
}

/** Call right after a successful SDK login (identity is pseudonymous — never PII). */
export function identifyUser(profile: { sub: string; orgId?: string | null }): void {
  const a = getAnalyticsAdapter();
  a?.identify?.(profile.sub);            // Zitadel `sub`
  if (profile.orgId) a?.group?.(profile.orgId); // tenant roll-up
}

// ---- surface-only events (the SDK can't see these) -------------------------
// Fired directly on the same Mixpanel instance so they inherit the super-props
// registered above. Keep the set small (~4) and the names stable.
type SurfaceEvent =
  | { name: "taskpane_opened"; props?: { entry?: string } }
  | { name: "draft_requested"; props: { kind: "reply" | "new" | "summary" } }
  | { name: "draft_inserted"; props: { kind: "reply" | "new" | "summary" } }
  | { name: "settings_changed"; props: { setting: string } };

export function trackSurface(e: SurfaceEvent): void {
  mp?.track(e.name, (e as { props?: Record<string, unknown> }).props ?? {});
}
```

## 3. Wire the calls (adapt to the add-in's real handlers)

```ts
// taskpane bootstrap
Office.onReady(async () => {
  initAnalytics(await getTenantConsent()); // your consent source
  trackSurface({ name: "taskpane_opened" });
});

// after SDK login resolves
const result = await login(identity, { clientId });
identifyUser(result.profile);            // { sub, orgId } from LoginResult

// draft flow
onGenerateClick(kind => trackSurface({ name: "draft_requested", props: { kind } }));
onInsertClick(kind  => trackSurface({ name: "draft_inserted",  props: { kind } }));

// settings
onSettingToggle(setting => trackSurface({ name: "settings_changed", props: { setting } }));
```

Everything else — the auth funnel, `message_send`/`stream_*` (TTFT), `api_error` — is designed
to flow from the SDK with no add-in code, but **none of it is wired yet** (blocker 2 above).
Registering the adapter is a prerequisite for it, not a trigger.

## 4. Min-event-set coverage (KR 2.1 — this surface passes when all three hold)

| Requirement | Satisfied by |
| --- | --- |
| **Retention** — `identify` + ≥1 event/session | `identifyUser` + `taskpane_opened` |
| **Activation** — first successful value | `draft_inserted` (SDK `stream_complete` as fallback) |
| **Funnel** | `taskpane_opened` → `draft_requested` → SDK `message_send`/`stream_complete` → `draft_inserted` |

## 5. Definition of Done (release gate — O2)

- [ ] On an SDK build that exports `./analytics/mixpanel` (next release, canary, or `file:` link); `mixpanel-browser` installed.
- [ ] `initAnalytics` runs once at startup; EU host; `ip:false`; consent-gated.
- [ ] `identifyUser` runs post-login; `distinct_id` = Zitadel `sub` only (no email/name).
- [ ] The 4 surface events fire; super-props present on every event (verify in Mixpanel).
- [ ] `api_error` shows in Mixpanel **without** any response body (PII scrub verified).
- [ ] Events visible in the **EU** project; `surface="outlook-addin"` slice works.
- [ ] 2–4 week baseline captured before wider fan-out (Word, web-component, mobile).

## 6. Notes

- **No magic strings for SDK events** — those are the SDK's typed `AnalyticsEventMap`.
  Surface events (`taskpane_opened`, …) are the add-in's own; keep them in the
  `SurfaceEvent` union above so they don't drift.
- **One Mixpanel project**, sliced by the `surface` super-prop — not a per-surface project.
- The fastest way to confirm the token + EU project before wiring the add-in is a throwaway
  script that inits `mixpanel-browser` against `api-eu.mixpanel.com` and fires one event —
  keep it outside the repo.
