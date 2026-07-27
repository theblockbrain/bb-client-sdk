# Analytics strategy — bb-client-sdk

> Repo-local summary of the domain spec **"SDK-First Product Analytics with Mixpanel — Design & Integration Spec"**
> ([Confluence, Tech Hub, page 1049559049](https://blockbrain.atlassian.net/wiki/spaces/Tech/pages/1049559049)).
> Canonical source is Confluence; this file is the engineering-side digest + how it maps to the code in this repo.
> Jira: PDEV-6854 (seam, this repo) · PDEV-7009 (Mixpanel seam) · PDEV-7011 (KR 2.1 standard) · PDEV-7010 (Outlook pilot) · PDEV-7012 (dashboard + MAU).

## 1. The bet: thin surface, thick SDK — applied to analytics

Mixpanel is the **usage half** of the combined Apps dashboard (Faro = RUM, Sentry = errors, Mixpanel = product analytics), and instrumentation is the **O2 release gate** — no Apps surface ships to production without emitting the minimum event set.

The SDK already wraps auth, the API client, streaming, and error typing — so it can **observe** almost every meaningful event. Rule of thumb: **if the SDK can observe it, the SDK emits it.** Each surface adds only ~3–6 events it alone can see (`taskpane_opened`, `draft_inserted`, …). One taxonomy, one identity model, one client — so the dashboard actually reconciles and no surface re-forks analytics.

## 2. Where the line sits in this repo

- **SDK owns** the seam + the typed taxonomy — **provider-agnostic core**. The SDK's core imports **no** Mixpanel/Sentry (`package.json` runtime dep is `marked` only). That is deliberate and load-bearing (invariant A / the whole injection-seam design).
  - `src/adapters/analytics.ts` — the `AnalyticsAdapter` interface + typed `AnalyticsEventMap` (single source of truth; no magic strings).
  - `src/analytics/index.ts` (`./analytics`) — the safe sink: `setAnalyticsAdapter` / `getAnalyticsAdapter` / `resetAnalyticsAdapter`, `trackEvent`, `captureError`, `trackApiError`, `flushAnalytics`. No-ops when unset; never throws into a product flow.
- **SDK also ships the Mixpanel adapter** as an **opt-in leaf** — no subproject needed:
  - `src/analytics/mixpanel.ts` (`./analytics/mixpanel`) — `createMixpanelAdapter(client, config)`: super-props, tenant grouping, a PII denylist, and a consent gate. It's typed **structurally** against the mixpanel-browser API, so the SDK adds **no dependency** and the core still tree-shakes clean (mixpanel only enters the graph if a surface imports this subpath).
- **Surfaces own** only the Mixpanel **instance**: `npm i mixpanel-browser`, `mixpanel.init(...)`, then hand it to `createMixpanelAdapter` and `setAnalyticsAdapter`.

```
@theblockbrain/bb-client-sdk/analytics           ── typed seam + safe sink (provider-agnostic)
@theblockbrain/bb-client-sdk/analytics/mixpanel  ── createMixpanelAdapter (opt-in; structural, no dep)
        │  setAnalyticsAdapter(createMixpanelAdapter(mixpanel, { superProps }))
        ▼
  surface: mixpanel-browser instance (init'd EU, ip:false)
        ▼
  Mixpanel (api-eu.mixpanel.com)
```

## 3. Identity model (KR 2.1)

| Field | Value | Notes |
| --- | --- | --- |
| `distinct_id` | Zitadel `sub` | Stable, pseudonymous. **Never** email/name. |
| super `tenant_id` / `org_id` | Zitadel org | Per-tenant MAU (the HARTING slice). |
| super `surface` | `outlook-addin`, … | One project, sliceable. |
| super `sdk_version` | auto | Version-integrity SLOs + canary. |
| super `app_version` / `host` / `env` | surface / platform | Keeps dev noise out of prod. |

**Privacy (hard):** pseudonymous id only; no email/name/subject/body ever; EU residency (`api-eu.mixpanel.com`); consent/opt-out gate (a disabled adapter is a silent no-op).

## 4. What the SDK counts (core catalog) — **auth wired, the rest still target**

To be emitted from SDK internals, identical across surfaces. The typed names live in
`AnalyticsEventMap` (which *is* on `main`); only the auth call site is wired:

- **Auth funnel** — `auth_started` → `auth_success` / `auth_failed` (coarse `stage`, never error detail) — **wired in `src/auth/login.ts`** (PDEV-6855), which also binds identity/group on success. `token_refresh` not yet wired.
- **AI funnel** — `message_send` → `stream_start` → `stream_first_token` (TTFT) → `stream_complete`; `stream_dropped` / `stream_reconnect`.
- **Errors** — `api_error` (scrubbed to `statusCode` + `endpoint`; **never** `responseBody`).

> Note: the taxonomy in `src/adapters/analytics.ts` (WS9 seam, PDEV-6854 — on `main`) uses these SDK-internal names. The Confluence spec's catalog uses product-funnel names (`conversation_started`, `message_completed`, …); mapping/aligning the two is the KR 2.1 standardization work (PDEV-7011). The adapter is the place to translate if the dashboard needs the spec's names.

## 5. Min-event-set (mandatory per surface)

Enough to compute **activation → funnel → retention**: `identify` + ≥1 event/session (MAU), first-value event (activation), and the funnel steps. KR 2.3 target = 100% of shipping surfaces emitting this.

## 6. Getting it into Grafana

Mixpanel has no native Grafana source. MVP: **Grafana Infinity plugin → Mixpanel Query API** (aggregate usage panels). Add a small **ETL** (Mixpanel Export/Engage → warehouse/Prometheus) for **MAU reconciliation < 5% vs backend** (the 287-vs-34 P0, KR 2.5).

## 7. Governance

- Typed event schema lives in the SDK; surfaces import names — **no raw event strings** (CI lint is planned, mirrors Blokkit's "ban raw hex").
- Event schema is **additive by default**; the public-API contract test guards the seam's exported surface.
- **One** Mixpanel project + a `surface` super-prop (not per-surface projects).
- **Release gate:** a build ships only when the min-event-set is observed in prod.

## 8. Try it

The adapter ships in the SDK; its test drives a full session against a Mixpanel
double and asserts the payloads (super-props registered, tenant grouped, response
body never forwarded, consent gate no-ops, never throws):

```bash
npx vitest run src/analytics       # sink + mixpanel adapter, 22 tests
```

> Both `./analytics` and `./analytics/mixpanel` are on `main` but **not in a published
> release** — the newest tag is `v0.17.0`, which predates them. A surface needs a canary
> build or a local `file:` link until the next release is cut.

Wiring it in a real browser surface (Outlook/Word/web-component):

```ts
import mixpanel from "mixpanel-browser";
import { identifyUser, setAnalyticsAdapter, setAnalyticsGroup } from "@theblockbrain/bb-client-sdk/analytics";
import { createMixpanelAdapter } from "@theblockbrain/bb-client-sdk/analytics/mixpanel";

mixpanel.init(MIXPANEL_TOKEN, { api_host: "https://api-eu.mixpanel.com", ip: false });
setAnalyticsAdapter(
  createMixpanelAdapter(mixpanel, {
    superProps: { surface: "outlook-addin", env: "prod", sdk_version: SDK_VERSION },
  }),
);

// `login()` already binds identity on success (PDEV-6855) — nothing to do there.
// Only a session RESTORED from storage (no login() call this session) needs it:
identifyUser(profile.sub);                                  // Zitadel `sub` — never PII
// `Profile.orgId` is `string | null` (src/auth/jwt.ts) — guard it. Passing null would
// register `tenant_id: null` as a sticky super-prop for the whole session.
if (profile.orgId) setAnalyticsGroup(profile.orgId);
```

The intent is that the SDK emits the core catalog (auth, chat/streaming, api_error) with the
surface adding only its own thin events. ⚠️ **Only the auth third is wired today** —
`src/auth/login.ts` emits `auth_started`/`auth_success`/`auth_failed` and binds identity
(PDEV-6855). `token_refresh`, `message_send`/`stream_*` and `api_error` are unwired, so §4 still
describes a target catalog rather than shipped behaviour for those.
