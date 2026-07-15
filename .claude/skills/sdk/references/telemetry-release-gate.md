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
- The SLO catalog's **"Part B" telemetry SLOs were *unmeasurable*** while the SDK exposed no telemetry seam; that seam is now **shipped (WS9)**. This doc specifies that seam **and** makes wiring it a checklist item, so Part B becomes measurable the moment a surface adopts it. Targets (crash-free %, error-rate %, activation) live in [`./slo-catalog.md`](./slo-catalog.md) — reference it, don't restate the numbers here.

**Dual audience.** The gate **binds every adapter (consumer) developer** — you cannot promote without it. The **SDK's** job is to make compliance cheap: provide the `AnalyticsAdapter` **seam** + a **standard event taxonomy** so a surface wires telemetry once and gets the whole event set for free. If a surface has to hand-roll event names, the SDK has failed its half.

---

## 1. The `AnalyticsAdapter` seam (SDK side)

**Status: SHIPPED (WS9).** The seam lives in `src/adapters/analytics.ts` (the types) and `src/analytics/index.ts` (the runtime sink); register an adapter at surface startup with `setAnalyticsAdapter` from `@theblockbrain/bb-client-sdk/analytics`. Each surface still supplies the concrete implementation that forwards to Mixpanel/Sentry/Faro — that is the one injected seam, and wiring it stays a release-gate obligation (see the [Definition of Done](#4-the-release-gate--definition-of-done)).

`AnalyticsAdapter` is a **peer of `StorageAdapter` and `IdentityAdapter`** (both verified in `src/adapters/`, exported as **types only** from `src/adapters/index.ts` and re-exported via `./adapters` + the root barrel `src/index.ts`). It follows the same injection pattern: **a pure interface, zero runtime, zero React, zero DOM** — the SDK calls it; the surface supplies the concrete implementation.

```ts
// Shipped (WS9): types in src/adapters/analytics.ts (exported via ./adapters);
// runtime sink + these type re-exports in src/analytics/index.ts (exported via ./analytics).

/** Typed taxonomy — a keyed interface, NOT a closed union. Keys are event names;
 *  values are the (PII-free) prop shape. Extend deliberately. See §2. */
export interface AnalyticsEventMap {
  auth_started: { mode: "oauth" | "api-key" };
  auth_success: { mode: "oauth" | "api-key"; latencyMs?: number };
  auth_failed: { mode: "oauth" | "api-key"; stage?: string };
  token_refresh: { ok: boolean; latencyMs?: number };
  message_send: { conversationId?: string; backend?: "blocky" | "agentic"; streaming: boolean };
  stream_start: { backend?: "blocky" | "agentic" };
  stream_first_token: { backend?: "blocky" | "agentic"; latencyMs?: number };
  stream_complete: { backend?: "blocky" | "agentic"; durationMs?: number };
  stream_dropped: { backend?: "blocky" | "agentic"; reason?: string };
  stream_reconnect: { backend?: "blocky" | "agentic"; attempt: number };
  /** HTTP failure — status + endpoint (+ method) only; NEVER the response body. */
  api_error: { statusCode: number; endpoint?: string; method?: string };
}
export type AnalyticsEventName = keyof AnalyticsEventMap;
export type AnalyticsEventProps<K extends AnalyticsEventName> = AnalyticsEventMap[K];

/** Stable, pseudonymous identity attached to events — never PII. */
export interface AnalyticsIdentity {
  distinctId?: string; // Zitadel `sub`
  orgId?: string;      // home org (tenant) — the analytics "group"
}

/** Extra context for `captureError`. Keep it PII/secret-free. */
export interface AnalyticsErrorContext extends AnalyticsIdentity {
  scope?: string; // coarse tag: "auth" | "stream" | "api"
  [key: string]: unknown;
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

**Design constraints (why it looks like this):**

| Constraint | Reason |
|---|---|
| Interface only — SDK never imports `mixpanel` / `@sentry/*` / Faro | **Invariant A** (framework-agnostic core) + **Invariant B** (no runtime assumptions). `./api` and `./auth` must tree-shake with zero telemetry vendor in the graph; `attw`/`publint` verify the export map. |
| Methods return `void` (sync, fire-and-forget) | Must never block the request path. Matters for **blocky-chat** (size-sensitive) and **bb-slack-integrations** (3-second Slack ack deadline). The surface's concrete impl batches/flushes. |
| Injected + **optional** at construction, but **required to ship** | The core must boot without it (a no-op default is fine) so the framework-agnostic layer has no hard dependency — but the [release gate](#4-the-release-gate--definition-of-done) forbids promoting a surface that left it unwired. |
| `distinctId` / `orgId` come from `AuthContext` | Single identity model across every surface (see §2). `userId` and `orgId` are already on `AuthContext` (`src/settings/auth-mode.ts`). |

**Where the SDK emits** (call sites, mapped to verified files — `login()` is live today; the rest are wired incrementally per call-site / per-surface):

| Event group | Call site (verified file) |
|---|---|
| `auth_started` / `auth_success` / `auth_failed` | **Live** in `src/auth/login.ts` (via `trackEvent`); `src/auth/browser-redirect.ts` + `src/auth/tokens.ts` (exchange) to follow |
| `token_refresh` | `src/auth/refresh-singleton.ts` (single-flight guard — emit once per real refresh, not per waiter) — **not yet wired** |
| `message_send`, `stream_*` | `src/api/messages.ts` (`sendMessage`) + `src/api/stream-result.ts` (`MessageStream`) / `src/api/blocky-sse.ts` — **wired incrementally** via `trackEvent(...)` |
| `api_error` | endpoints/surfaces call `trackApiError(err)` in a catch block (forwards only `statusCode` + `endpoint` off `BBApiError`; never `responseBody`) — **wired incrementally** per call site |

---

## 2. Event taxonomy + identity model

The SDK emits **one** standard event set through the seam so every surface reports the same funnel. Surfaces may add surface-specific events, but these are the **minimum contract**.

### Event taxonomy

| Event | When | Key props |
|---|---|---|
| `auth_started` | OAuth/PKCE or api-key flow begins | `mode` (`oauth` \| `api-key`) |
| `auth_success` | Token obtained / valid `AuthContext` produced | `mode`, `latencyMs` |
| `auth_failed` | Login or token exchange fails | `mode`, `stage` (coarse phase — no token, no PII) |
| `token_refresh` | A real refresh completes (single-flight — one event per refresh) | `ok`, `latencyMs` |
| `message_send` | `sendMessage` invoked | `backend` (`blocky` \| `agentic`), `streaming`, `conversationId` |
| `stream_start` | Stream opened (first read of `MessageStream.textDeltas`) | `backend` |
| `stream_first_token` | First delta yielded — the perceived-latency milestone | `backend`, `latencyMs` |
| `stream_complete` | `MessageStream.final` resolves | `backend`, `durationMs` |
| `stream_dropped` | `final` rejects / source throws mid-stream | `backend`, `reason` |
| `stream_reconnect` | Transport reconnect attempted (SSE/EventSource) | `backend`, `attempt` |
| `api_error` | Any `./api` call throws `BBApiError` | `statusCode`, `endpoint`, `method` |

**Streaming lifecycle maps to the verified `MessageStream` contract** (`src/api/stream-result.ts`): first yield of `textDeltas` → `stream_first_token`; `final` resolve → `stream_complete`; `final` reject → `stream_dropped`. Blocky's non-SSE JSON path (`wrapStringAsStream`) still emits `stream_start` + `stream_complete` (single delta), so the funnel shape is uniform across Blocky and Agentic.

**`api_error` props come straight off `BBApiError`** (`src/api/errors.ts`): `statusCode` and `endpoint` (optionally `method`) — there is **no** `path` field. The SDK's `trackApiError(err)` forwards only `statusCode` + `endpoint`. **Never** attach `responseBody` raw — scrub it first (see below). README already ties `statusCode===401` → re-auth and `503` → not configured; those become dashboard slices.

### Identity model (org-wide, one model)

| Concept | Value | Source |
|---|---|---|
| **distinct id** | Zitadel **`sub`** | `AuthContext.userId` (OAuth mode) — derived via `subFromAccessToken()` in `src/utils/jwt.ts` when not threaded explicitly. **api-key mode has no `sub`** → identify anonymously / by service principal, never invent a user id. |
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
- **ms-outlook-addin** — the reference adopter and **canary target**; now that WS9 has shipped it should be first to wire the seam (mind its stale `^0.7.3` pin — see Invariant C).

---

## 4. THE RELEASE GATE — Definition of Done

Every surface ticks **every** box before promotion to production. This is the checklist referenced by the gate; it is not optional or partial.

- [ ] **`AnalyticsAdapter` wired** — a concrete implementation is injected via `setAnalyticsAdapter` at startup (forwarding to Mixpanel + Sentry). No no-op left in production.
- [ ] **Minimum event set emitting** — `auth_success` / `auth_failed`, `message_send`, `stream_start` / `stream_first_token` / `stream_complete` / `stream_dropped`, `api_error{statusCode,endpoint}`, all with the §2 props.
- [ ] **Events verified** — confirmed **arriving in Mixpanel** (not just called locally): correct names, `distinct_id` = Zitadel `sub`, group = `orgId`, **no PII / no tokens** in any payload.
- [ ] **Sentry live** — errors reach the correct Sentry project with release/version tags; **`captureError` scrubs tokens** and `BBApiError.responseBody`.
- [ ] **Browser RUM live** (browser surfaces) — **Faro** reporting Web Vitals; **mobile** — Sentry RN + store vitals instead (Faro N/A).
- [ ] **Dashboards exist** — a **crash-free rate** dashboard and an **error-rate** dashboard for this surface, with the [SLO](./slo-catalog.md) targets marked.
- [ ] **Identity model correct** — `identify(sub)` + `group(orgId)` on auth success; anonymous/service identity in api-key mode (never a fabricated user id).
- [ ] **Multi-tenant safe** — grouping uses `AuthContext.orgId` (home org); no `targetOrgId` leaks into analytics grouping.
- [ ] **Gate enforced in CI/release** — promotion is blocked until the above are checked. See the [known publish gap](#ci--release-enforcement).

### CI / release enforcement

Merge is gated by **`ci.yml`** on `main` (lint:biome → lint:types → typecheck → test → build → check:package) under branch protection. **Known gap (SLO E2):** **`publish.yml`** runs **only typecheck + build** on a `vX.Y.Z` tag — it does **not** re-run test / lint / `check:package`, and it does **not** verify telemetry. Until E2 closes ("CI + publish both gated on tests"), the telemetry DoD is a **per-surface promotion gate**, not something the SDK's publish pipeline can prove for you. Do not treat "the SDK published" as "the surface is instrumented" — they are separate gates.

---

## Related references

- [`./adapters.md`](./adapters.md) — the adapter matrix (runtimes / frameworks / auth / storage / CSP) to check on every change (**Invariant C**).
- [`./slo-catalog.md`](./slo-catalog.md) — the SLO targets (crash-free %, error rate %, activation, TTFT) this gate makes measurable; Part A vs Part B.
- [`../SKILL.md`](../SKILL.md) — the base `/sdk` skill: invariants, verification loop, canary-before-latest.
- Org coding standard — [`/Users/chihebhmida/Documents/Glassbox/SKILL.md`](/Users/chihebhmida/Documents/Glassbox/SKILL.md) (import order, no `any`, early returns, error handling, verification checklist). The seam and event props follow it; don't restate it here.
