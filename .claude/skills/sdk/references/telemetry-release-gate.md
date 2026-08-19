---
name: telemetry-release-gate
description: Use when adding, wiring, or reviewing telemetry for any BlockBrain Apps surface, when defining the AnalyticsAdapter seam in the SDK, or when deciding whether a surface is allowed to promote to production. States the non-negotiable "instrument every surface" release gate, the AnalyticsAdapter seam the SDK must expose, the standard event taxonomy + identity model, the tool mapping, and the Definition-of-Done checklist every surface ticks before it ships.
---

# Telemetry Release Gate — Instrument Every Surface

> **Inherits from**: [/sdk](../SKILL.md) — see that skill for the adapter matrix, invariants, and verification loop. This doc is the telemetry-specific expansion of **Invariant E** (instrument every surface) and part of **Invariant D** (security in every layer). Do not restate the base content here; link to it.

> ## THE RULE (documented, non-negotiable)
> **Nothing ships to production without BOTH:**
> 1. **Product analytics** — Mixpanel: activation / funnel / retention, one shared identity model, **no PII**.
> 2. **Health telemetry** — crash/error: **Sentry** (+ **Grafana Faro** RUM on browser surfaces): crash-free rate + error rate.
>
> This is a **hard release gate**, enforced per surface (see the [Definition of Done](#4-the-release-gate--definition-of-done)). A surface that emits neither, or only one, is **not** promotable — no exceptions, no "we'll add it after launch."

## Why this gate exists

We have shipped Apps surfaces **blind** — no funnel, no crash-free number, no error-rate baseline — so we could not tell activation from churn, or a bad release from a quiet one. Objective **O2** ("ship measurable, healthy surfaces") makes instrumentation a precondition of release rather than a follow-up. Concretely:

- Mixpanel is being adopted **org-wide as core product**; Apps adopts the **same** foundation and identity model so Apps data joins the org's, rather than forking a second analytics universe.
- The SLO catalog's **"Part B" telemetry SLOs were *unmeasurable*** while the SDK exposed no telemetry seam; that seam **ships in `0.18.0` (WS9 — PDEV-6854/6855, PR #22)**. This doc specifies that seam **and** makes wiring it a checklist item, so Part B becomes measurable as soon as a surface adopts it. Targets (crash-free %, error-rate %, activation) live in [`./slo-catalog.md`](./slo-catalog.md) — reference it, don't restate the numbers here.

**Dual audience.** The gate **binds every adapter (consumer) developer** — you cannot promote without it. The **SDK's** job is to make compliance cheap: provide the `AnalyticsAdapter` **seam** + a **standard event taxonomy** so a surface wires telemetry once and gets the whole event set for free. If a surface has to hand-roll event names, the SDK has failed its half.

---

## 1. The `AnalyticsAdapter` seam (SDK side)

**Status: ships in `0.18.0` (WS9 — PDEV-6854 seam + PDEV-6855 `auth_*` instrumentation); `v0.17.0` predates it.** The seam lives in `src/adapters/analytics.ts` (the types) and `src/analytics/index.ts` (the runtime sink); register an adapter at surface startup with `setAnalyticsAdapter` from `@theblockbrain/bb-client-sdk/analytics`. A surface either supplies its own concrete implementation forwarding to Mixpanel/Sentry/Faro, or takes the ready-made `createMixpanelAdapter` from `@theblockbrain/bb-client-sdk/analytics/mixpanel` (§1a). Either way that is the one injected seam, and wiring it stays a release-gate obligation (see the [Definition of Done](#4-the-release-gate--definition-of-done)).

`AnalyticsAdapter` is a **peer of `StorageAdapter` and `IdentityAdapter`** (both verified in `src/adapters/`, exported as **types only** from `src/adapters/index.ts` and re-exported via `./adapters` + the root barrel `src/index.ts`). It follows the same injection pattern: **a pure interface, zero runtime, zero React, zero DOM** — the SDK calls it; the surface supplies the concrete implementation.

> ### ⚠️ The vocabulary moved in `0.20.0` — this section was rewritten
>
> `AnalyticsEventMap` used to declare its own event map here, with `auth_*` names
> and camelCase props. It was a **second vocabulary for the same concepts**, and
> the one in `src/telemetry/taxonomy.ts` won. `AnalyticsEventMap` is now an alias:
> `export type AnalyticsEventMap = CoreEventMap`. Import `CoreEventMap` from
> `@theblockbrain/bb-client-sdk/telemetry`; the alias is `@deprecated` and keeps
> only the NAME resolving, not the old shape. `LEGACY_EVENT_RENAMES` (also in
> `./telemetry`) is the machine-readable old→new map. Full migration table: see
> the `0.20.0` section of [`CHANGELOG.md`](../../../../CHANGELOG.md).

```ts
// src/telemetry/taxonomy.ts — the ONE vocabulary, exported via ./telemetry.
// src/adapters/analytics.ts aliases it so `./adapters` type references keep resolving.

/** Typed taxonomy — a keyed interface, NOT a closed union. Keys are event names;
 *  values are the (PII-free) prop shape. Extend deliberately. See §2.
 *  snake_case on the wire, because these property names double as Prometheus
 *  label names downstream (`status_code`, `ttft_ms`, `latency_ms`). */
export interface CoreEventMap {
  // ── auth ──
  sign_in_started: { method: SignInMethod };                  // password | sso | oidc | api_key
  sign_in_completed: { method: SignInMethod; owner_permission?: OwnerPermission; latency_ms?: number };
  sign_in_failed: { method: SignInMethod; stage?: SignInStage; error_code?: string };
  session_token_refreshed: { latency_ms?: number };
  session_token_refresh_failed: { error_code?: string };
  sign_out: { cause: SignOutCause };

  // ── the AI funnel ──
  conversation_started: { conversation_id: string; route: Route; bot_id?: string; /* … */ };
  message_sent: { conversation_id: string; message_id: string; route: Route; /* … */ };
  /** Carries `ttft_ms`, the source of the TTFT p95 SLO. */
  message_first_token: { route: Route; request_id?: string; ttft_ms: number };
  message_completed: { route: Route; request_id?: string; duration_ms?: number; outcome: Outcome; /* … */ };
  message_failed: { route: Route; stage?: MessageFailedStage; error_code?: string };

  // ── stream health ──
  stream_started: { route: Route; request_id?: string; conversation_id?: string };
  stream_stalled: { route: Route; request_id?: string; stall_ms: number };
  stream_dropped: { route: Route; reason?: StreamDropReason };
  stream_reconnect: { route: Route; attempt: number };

  // ── errors ──
  error_raised: { scope: ErrorScope; error_code?: string; request_id?: string; is_blocking?: boolean };
  /** HTTP failure — status + endpoint (+ method) only; NEVER the response body. */
  api_error: { status_code: number; endpoint?: string; method?: string };
}
/** `CORE_EVENT_NAMES` is proved exhaustive against this map at compile time. */
export type CoreEventName = keyof CoreEventMap;

// src/adapters/analytics.ts — @deprecated aliases, kept so 0.19.0 type references resolve.
export type AnalyticsEventMap = CoreEventMap;
export type AnalyticsEventName = CoreEventName;
export type AnalyticsEventProps<K extends AnalyticsEventName> = CoreEventProps<K>;

/** Stable, pseudonymous identity attached to events — never PII. */
export interface AnalyticsIdentity {
  distinctId?: string; // Zitadel `sub`
  orgId?: string;      // home org (tenant) — the analytics "group"
}

/** Extra context for `captureError`. Keep it PII/secret-free. */
export interface AnalyticsErrorContext extends AnalyticsIdentity {
  scope?: string; // coarse tag: "auth" | "stream" | "api"
  // Primitives only, so a whole object (e.g. a raw response body) can't be attached by accident.
  [key: string]: string | number | boolean | null | undefined;
}

export interface AnalyticsAdapter {
  /** Product event → Mixpanel. Typed by the taxonomy. Fire-and-forget; MUST NOT throw. */
  track<K extends AnalyticsEventName>(
    event: K,
    props: AnalyticsEventProps<K>,
    identity?: AnalyticsIdentity,
  ): void;

  /** Crash/error → Sentry (+ Faro on browser). Never pass tokens/PII; never forward `BBApiError.responseBody` raw. */
  captureError(error: unknown, context?: AnalyticsErrorContext): void;

  /** Bind the current user (Zitadel `sub`). Optional. */
  identify?(distinctId: string, traits?: Readonly<Record<string, string | number | boolean>>): void;

  /** Bind the active tenant as an analytics group. Optional. */
  group?(orgId: string, traits?: Readonly<Record<string, string | number | boolean>>): void;

  /** Flush buffered events (e.g. before unload / process exit). Optional. */
  flush?(): Promise<void> | void;
}
```

The **runtime sink** is `./analytics` (`src/analytics/index.ts`): `setAnalyticsAdapter(adapter | null)` registers the process-wide adapter (call once at startup), `getAnalyticsAdapter()` / `resetAnalyticsAdapter()` read/detach it, and the SDK emits through the safe helpers `trackEvent(event, props, identity?)`, `captureError(error, context?)`, `trackApiError(error, identity?)`, and `flushAnalytics()`. These **no-op when no adapter is registered and never throw/reject into the caller** — telemetry cannot break a product flow. `./analytics` also re-exports every analytics type from `./adapters`.

**Identity binding — `identifyUser(distinctId)` / `setAnalyticsGroup(orgId)`.** The `identity` argument to `trackEvent` tags only the one event it is passed to. Most events (`message_sent`, `stream_*`, `api_error`) carry none, so without a binding a Mixpanel-backed adapter attributes them to the anonymous device id and org roll-up stays empty. These two guarded helpers forward to the adapter's optional `identify`/`group` (same contract: no-op when absent, never throw). `login()` calls both on success; a surface that restores a session from storage — no `login()` call — must call them itself at startup.

⚠️ **The binding is process-wide.** A **multi-tenant server** adapter (bb-slack-integrations: one process, many orgs) must **NOT** implement `identify`/`group` — the last caller's identity would become the default for every later event, a cross-tenant attribution leak. Such adapters omit both, the helpers no-op, and per-event `identity` remains the only attribution path.

**Design constraints (why it looks like this):**

| Constraint | Reason |
|---|---|
| Interface only — SDK never imports `mixpanel` / `@sentry/*` / Faro | **Invariant A** (framework-agnostic core) + **Invariant B** (no runtime assumptions). `./api` and `./auth` must tree-shake with zero telemetry vendor in the graph; `attw`/`publint` verify the export map. |
| Methods return `void` (sync, fire-and-forget) | Must never block the request path. Matters for **blocky-chat** (size-sensitive) and **bb-slack-integrations** (3-second Slack ack deadline). The surface's concrete impl batches/flushes. |
| Injected + **optional** at construction, but **required to ship** | The core must boot without it (a no-op default is fine) so the framework-agnostic layer has no hard dependency — but the [release gate](#4-the-release-gate--definition-of-done) forbids promoting a surface that left it unwired. |
| `distinctId` / `orgId` come from `AuthContext` | Single identity model across every surface (see §2). `userId` and `orgId` are already on `AuthContext` (`src/settings/auth-mode.ts`). |

**Where the SDK emits** (call sites, mapped to verified files). As of `0.20.0` the auth funnel, the session-refresh pair and the whole turn/stream funnel are wired; **`api_error` is the one group still unwired** (PDEV-7009). Confirm with `grep -rn "trackEvent\|trackApiError" src/`:

| Event group | Call site (verified file) |
|---|---|
| `sign_in_started` / `sign_in_completed` / `sign_in_failed` | `src/auth/login.ts` — **wired** (PDEV-6855, recovered from the dead `feat/PDEV-6855/instrument-auth-telemetry` branch after PR #20 merged into an already-merged base). Emits `sign_in_started{method:"oidc"}` at entry, `sign_in_completed{latency_ms}` + identity binding (`identifyUser`/`setAnalyticsGroup`) on success, `sign_in_failed{stage}` from a `catch` with a coarse `launch\|parse\|exchange` label and no error detail; the original error is re-thrown unchanged. Covered by `src/auth/login.test.ts`. `src/auth/browser-redirect.ts` + `src/auth/tokens.ts` (exchange) to follow |
| `session_token_refreshed` / `session_token_refresh_failed` | `src/auth/refresh-singleton.ts` — **wired**. Emitted from inside the single-flight guard, so one event per REAL refresh rather than one per waiter: that is what makes a refresh storm visible instead of looking like normal traffic. `error_code` comes from `telemetryErrorCode`, which reads `kind` before `statusCode` so `network`/`timeout`/`aborted` do not all collapse to `"0"`. Covered by `src/auth/refresh-singleton.test.ts` |
| `message_sent`, `message_failed`, `message_first_token`, `message_completed`, `stream_*` | `src/api/messages.ts` (`sendMessage`) + `src/api/stream-result.ts` (`MessageStream`) — **wired**. `messages.ts` mints one id per send (`message_id`, then `request_id` on every event the stream emits), derives `route` from the conversation's agent at runtime, and guarantees that **every** send which emitted `message_sent` emits exactly one terminal event — a failure emits `message_failed{stage,error_code}` plus `message_completed{outcome:"error"}`. `stream-result.ts` owns the stream half because it is where both backends converge. Covered by `src/api/messages.telemetry.test.ts` + `src/api/stream-result.test.ts` |
| `api_error` | `throwIfNotOk` in `src/api/_send.ts` is the intended single emit point (PDEV-7009) — every non-2xx from every endpoint on every host passes through it, so no endpoint has to remember. It forwards only `statusCode` → `status_code` and `endpoint`, never `responseBody`. **Not yet wired** |

### 1a. The Mixpanel leaf (`./analytics/mixpanel`)

The seam is provider-agnostic, but the Mixpanel taxonomy, identity model and PII rules are
identical on every surface — so the SDK owns them once instead of each surface re-deriving them.
`src/analytics/mixpanel.ts` exports `createMixpanelAdapter(client, config)`, an `AnalyticsAdapter`
backed by a Mixpanel-shaped client:

- **No new dependency.** `MixpanelClient` is a **structural** type over the four
  `mixpanel-browser` methods used (`track` / `identify` / `register` / optional `set_group`).
  A real `mixpanel` instance satisfies it; so does a test double. The SDK never imports
  `mixpanel-browser` — invariant A holds, and the core only pulls this module in if a surface
  imports the subpath.
- **Super-props** (`surface`, `env`, `sdk_version?`, `app_version?`, `host?`) are `register`ed
  once at creation, so every event carries the dashboard's slice keys.
- **Tenant roll-up.** `identity.orgId` is attached under `groupKey` (default `tenant_id`);
  `group(orgId)` also calls `set_group` for Mixpanel Group Analytics.
- **PII denylist + consent gate.** A field denylist (`email`, `name`, `*_token`, `responseBody`,
  `body`, …) scrubs every payload as a second line of defence, and `enabled: false` makes every
  method a silent no-op. `captureError` forwards only the error **name** — never message or stack.
- **Never throws.** Setup, `identify` and `group` are individually guarded.

```ts
import mixpanel from "mixpanel-browser";
import { setAnalyticsAdapter } from "@theblockbrain/bb-client-sdk/analytics";
import { createMixpanelAdapter } from "@theblockbrain/bb-client-sdk/analytics/mixpanel";

mixpanel.init(MIXPANEL_TOKEN, { api_host: "https://api-eu.mixpanel.com", ip: false });
setAnalyticsAdapter(
  createMixpanelAdapter(mixpanel, {
    enabled: consentGranted,
    superProps: { surface: "outlook-addin", env: "prod", sdk_version: SDK_VERSION },
  }),
);
```

Covered by `src/analytics/mixpanel.test.ts` (super-props registered, tenant grouped, response body
never forwarded, consent gate no-ops, faults never escape).

---

## 2. Event taxonomy + identity model

The SDK emits **one** standard event set through the seam so every surface reports the same funnel. Surfaces may add surface-specific events, but these are the **minimum contract**.

### Event taxonomy

Names and props below are the `0.20.0` vocabulary (`CoreEventMap`). For the old
`auth_*` / camelCase set and the old→new mapping, see `LEGACY_EVENT_RENAMES` in
`./telemetry` and the `0.20.0` section of [`CHANGELOG.md`](../../../../CHANGELOG.md).

| Event | When | Key props |
|---|---|---|
| `sign_in_started` | OAuth/PKCE or api-key flow begins | `method` (`password` \| `sso` \| `oidc` \| `api_key`) |
| `sign_in_completed` | Token obtained / valid `AuthContext` produced | `method`, `latency_ms`, `owner_permission` |
| `sign_in_failed` | Login or token exchange fails | `method`, `stage` (coarse phase — no token, no PII), `error_code` |
| `session_token_refreshed` | A real refresh succeeds (single-flight — one event per refresh) | `latency_ms` |
| `session_token_refresh_failed` | A real refresh fails | `error_code` (coarse — never a message) |
| `sign_out` | Session ends | `cause` |
| `message_sent` | `sendMessage` invoked | `conversation_id`, `message_id`, `route` (`chat` \| `agent` \| …) |
| `stream_started` | Stream opened | `route`, `request_id`, `conversation_id` |
| `message_first_token` | First delta yielded — the perceived-latency milestone | `route`, `request_id`, `ttft_ms` |
| `message_completed` | `MessageStream.final` resolves, or a buffered send returns | `route`, `request_id`, `duration_ms`, `outcome` |
| `message_failed` | The turn fails before completing | `route`, `stage`, `error_code` |
| `stream_stalled` | No delta for longer than the stall budget | `route`, `request_id`, `stall_ms` |
| `stream_dropped` | `final` rejects / source throws mid-stream | `route`, `reason` (closed `StreamDropReason`) |
| `stream_reconnect` | Transport reconnect attempted (SSE/EventSource) | `route`, `attempt` |
| `error_raised` | A handled error surfaced to the user | `scope`, `error_code`, `is_blocking` |
| `api_error` | Any `./api` call throws `BBApiError` | `status_code`, `endpoint`, `method` |

**`message_completed` replaced `stream_complete` deliberately**: the terminal event
belongs to the TURN, not to the transport, so a non-streaming send closes the same
funnel a streamed one does. `stream_dropped` is transport health and is emitted
*alongside* `message_completed{outcome:"error"}` — they are not redundant, and
emitting only the drop leaves the funnel with no denominator for failed turns.

**Streaming lifecycle maps to the verified `MessageStream` contract** (`src/api/stream-result.ts`): first yield of `textDeltas` → `message_first_token`; `final` resolve → `message_completed{outcome:"success"}`; `final` reject → `stream_dropped` + `message_completed{outcome:"error"}`. Blocky's non-SSE JSON path (`wrapStringAsStream`) emits `stream_started` + `message_completed` but deliberately **no** `message_first_token`: it is handed an already-complete response, so the only TTFT it could report is a fabricated `0` feeding the same p95 the real path does.

**`api_error` props come straight off `BBApiError`** (`src/api/errors.ts`): `statusCode` and `endpoint` (optionally `method`) — there is **no** `path` field. Note the rename across the boundary: the error field is `statusCode`, the **event** prop is `status_code`, because the taxonomy's names double as Prometheus label names. The SDK's `trackApiError(err)` forwards only those two. **Never** attach `responseBody` raw — scrub it first (see below). README already ties `statusCode===401` → re-auth and `503` → not configured; those become dashboard slices.

### Identity model (org-wide, one model)

| Concept | Value | Source |
|---|---|---|
| **distinct id** | Zitadel **`sub`** | `AuthContext.userId` (OAuth mode) — derived via `subFromAccessToken()` in `src/auth/jwt-claims.ts` when not threaded explicitly. **api-key mode has no `sub`** → identify anonymously / by service principal, never invent a user id. |
| **group** | **org** (tenant) | `AuthContext.orgId` (the HOME org). Call `group(orgId)` so retention/activation roll up per tenant. |
| **PII** | **NONE** | No email, name, message content, or free-text prompt. `sub` + `orgId` are opaque IDs — that is the whole identity. |

**Multi-tenant discipline (Invariant D):** group on `AuthContext.orgId` (home org) only. For cross-tenant admin calls the tenant lives in a per-call `targetOrgId` (→ `?orgId=`), **not** in `AuthContext` — do **not** let analytics grouping leak a target tenant into the user's own group. Zero cross-tenant leakage applies to telemetry too (critical for **bb-slack-integrations**, zero-tolerance tenant mapping).

**Token scrubbing (mandatory, Invariant D):** tokens are never logged and never leave secure storage. Before `captureError`/`track`, strip `AuthContext.token`, any `Authorization`/`x-*` auth header, and `BBApiError.responseBody` free-text. Tokens must never reach Sentry/Mixpanel payloads, a bundle, or a `NEXT_PUBLIC_`/public env var (the `bb-integration-example` `NEXT_PUBLIC_` token-exposure incident is the cautionary tale).

---

## 3. Tool mapping

| Tool | Owns | Applies to | Notes |
|---|---|---|---|
| **Mixpanel** | Product / usage: activation, funnel, retention | **Every** surface (browser, Node, mobile, Lit) | Wired via `AnalyticsAdapter.track` / `identify` / `group`. Node surfaces (Slack) use `mixpanel` server SDK; browser/Lit use the browser SDK; mobile uses the RN SDK. Same taxonomy + identity everywhere. |
| **Sentry** | Crash / error | **Every** surface | Wired via `AnalyticsAdapter.captureError`. Browser/Lit → Sentry browser; **mobile → Sentry React Native**; Slack/Node → Sentry Node. |
| **Grafana Faro** | Browser RUM + Web Vitals (LCP/CLS/INP), crash-free (browser) | **Browser surfaces only** — Outlook/Word/PowerPoint/Excel add-ins, SharePoint/SPFx, blocky-frontend, blocky-chat (Lit) | **Faro does NOT support React Native.** Do not attempt to wire Faro into blocky-mobile. |
| **Mobile: Sentry RN + store vitals** | Crash-free + app health on device | **blocky-mobile** (React Native / Expo) | Faro's browser-RUM slot is filled by **Sentry RN + App Store / Play Console vitals**. Crash-free reality on mobile runs lower than web — track it explicitly. |

**Surface-shape reminders (see the [adapter matrix](./adapters.md)):**

- **bb-slack-integrations** — Node backend, no DOM: **no Faro, no browser RUM**. Server-side Mixpanel + Sentry Node. Respect the 3-second ack — telemetry is fire-and-forget, never on the ack path.
- **b2b-webcomponents / blocky-chat** — Lit, not React: `./react` and `./ui` are irrelevant; only the framework-agnostic core (incl. this seam) applies. Size-sensitive (~3.5 MB CDN bundle) — the concrete analytics SDK is the surface's cost to bear, not the core's.
- **ms-outlook-addin** — the reference adopter and **canary target**; first in line to wire the seam (PDEV-7010). Until its pin reaches `0.18.0` it needs a canary or `file:` link — `npm run release:status` prints where it is. See Invariant C.

---

## 4. THE RELEASE GATE — Definition of Done

Every surface ticks **every** box before promotion to production. This is the checklist referenced by the gate; it is not optional or partial.

- [ ] **`AnalyticsAdapter` wired** — a concrete implementation is injected via `setAnalyticsAdapter` at startup (forwarding to Mixpanel + Sentry). No no-op left in production.
- [ ] **Minimum event set emitting** — `sign_in_completed` / `sign_in_failed`, `message_sent`, `stream_started` / `message_first_token` / `message_completed` / `stream_dropped`, `api_error{status_code,endpoint}`, all with the §2 props.
- [ ] **Events verified** — confirmed **arriving in Mixpanel** (not just called locally): correct names, `distinct_id` = Zitadel `sub`, group = `orgId`, **no PII / no tokens** in any payload.
- [ ] **Sentry live** — errors reach the correct Sentry project with release/version tags; **`captureError` scrubs tokens** and `BBApiError.responseBody`.
- [ ] **Browser RUM live** (browser surfaces) — **Faro** reporting Web Vitals; **mobile** — Sentry RN + store vitals instead (Faro N/A).
- [ ] **Dashboards exist** — a **crash-free rate** dashboard and an **error-rate** dashboard for this surface, with the [SLO](./slo-catalog.md) targets marked.
- [ ] **Identity model correct** — `identify(sub)` + `group(orgId)` on auth success; anonymous/service identity in api-key mode (never a fabricated user id).
- [ ] **Multi-tenant safe** — grouping uses `AuthContext.orgId` (home org); no `targetOrgId` leaks into analytics grouping.
- [ ] **Gate enforced in CI/release** — promotion is blocked until the above are checked. See the [known publish gap](#ci--release-enforcement).

### CI / release enforcement

Merge is gated by **`ci.yml`** on `main` (lint:biome → lint:types → typecheck → test → build → check:package) — but **not enforced**: branch protection on `main` is currently off (`gh api repos/theblockbrain/bb-client-sdk/branches/main/protection` → 404), so CI is advisory. **SLO E2 is closed:** since PDEV-7001 **`publish.yml`** re-runs the full suite on a `vX.Y.Z` tag. It still does **not** verify telemetry, and it cannot — the telemetry DoD is a **per-surface promotion gate**, not something the SDK's publish pipeline can prove for you. Do not treat "the SDK published" as "the surface is instrumented" — they are separate gates.

---

## Related references

- [`./adapters.md`](./adapters.md) — the adapter matrix (runtimes / frameworks / auth / storage / CSP) to check on every change (**Invariant C**).
- [`./slo-catalog.md`](./slo-catalog.md) — the SLO targets (crash-free %, error rate %, activation, TTFT) this gate makes measurable; Part A vs Part B.
- [`../SKILL.md`](../SKILL.md) — the base `/sdk` skill: invariants, verification loop, canary-before-latest.
- Org coding standard — **Code Cleanup & Refactoring** standard (import order, no `any`, early returns, error handling, verification checklist). The seam and event props follow it; don't restate it here.
