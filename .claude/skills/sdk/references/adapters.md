---
name: sdk-adapters-matrix
description: Use when verifying that a change to @theblockbrain/bb-client-sdk is safe across every consuming surface — the adapter compatibility matrix (runtime / framework / module / transport / auth / storage / CSP / adoption), the capability gaps the SDK still owes adapters, and the per-runtime gotchas that break a naive change. Load this in the "verify all cases" step of any SDK task.
---

# Adapter compatibility matrix

> **Inherits from**: `/sdk` — see that skill for the invariants (A–E), the security model, and the verification loop. This file is the **single source of truth for "verify all cases."** It is referenced by the base skill and by every sub-skill's verify phase. Do not duplicate invariant text here; link to it.

This SDK is "thin surface, thick SDK": one package fans out to **every** BlockBrain Apps surface. A change that breaks any one adapter is a defect (invariant **C**). Before you ship a change to a public export, walk this matrix and answer: *which runtimes / frameworks / auth flows / storage / CSP does it touch, and does it break any?*

## How to read this file (dual audience)

- **SDK maintainers**: use the matrix as your blast-radius checklist. A public-export change must pass `src/public-api.contract.test.ts` (snapshot in `src/__snapshots__/`) **and** be canary-tested in a consumer (Outlook) before it hits the `latest` dist-tag. See `canary.yml`.
- **Adapter (consumer) developers**: find your row, honor your runtime's gotchas, and implement the injection seams (`StorageAdapter`, `IdentityAdapter`) for your platform. The seams are the only sanctioned way to reach platform I/O — see `src/adapters/`.

### Verified vs. verify-in-consumer

Everything in the **left three columns of the SDK's own facts** (export surface, adapter interfaces, config, known client IDs) is verified against this repo. **Consumer-side facts** — version pins, whether a surface uses axios vs. fetch, exact storage backend, live adoption — live in each consumer repo, **not here**. Those cells are the best current understanding; treat them as "verify in `<consumer-repo>`" before you rely on them. The SDK repo only confirms which consumers exist by name (`src/config.ts` client-ID table; README theme table) and the export map (`package.json` `exports`).

---

## The matrix

Legend — **Runtime**: BW = browser webview (Office.js) · SPFx = SharePoint Framework · Node = server · RN = React Native/Expo · SPA = browser single-page app · Lit-CDN = web component served from CDN. **Auth**: PKCE-dlg = PKCE via a platform dialog · redirect = full-page redirect · device = OAuth device-code (**SDK gap**, see below) · api-key = static token · proxy = bespoke proxy. **Storage**: the concrete `StorageAdapter` backend. **CSP**: strict = tight allowlist (Office/SPFx/extension).

| Adapter | Runtime | Framework | Module / bundler constraints | Transport | Auth flow | StorageAdapter backend | CSP | On the SDK today? |
|---|---|---|---|---|---|---|---|---|
| **ms-outlook-addin** | BW | React | ESM | fetch | PKCE-dlg (`Office…displayDialogAsync`) | `Office.context.roamingSettings` (async, size-limited) | strict | **Yes — `^0.17.0`** (one era behind as of `0.18.0`; it sat on a stale `^0.7.3` until 2026-07). Reference adopter; `api.ts` is a re-export barrel from the SDK. Client ID `373051238587049311` (`src/config.ts`). |
| **ms-word-addin** | BW | React | ESM | fetch | PKCE-dlg | `roamingSettings` (async, size-limited) | strict | No (0%). **Migration target** — hand-rolls ~2,685 LOC of `api/*`, a ~124-line SSE loop, and PKCE. Slice order: types → endpoints → streaming → auth → flags. Office.js doc manipulation stays in the surface. |
| **ms-powerpoint-addin** | BW | React | ESM | fetch | PKCE-dlg (reuses Outlook dialog auth) | `roamingSettings` (async, size-limited) | strict | No — **greenfield**. Direct-prompting task pane. |
| **ms-excel-addin** | BW | React | ESM | fetch | PKCE-dlg (reuses Outlook dialog auth) | `roamingSettings` (async, size-limited) | strict | No — **greenfield**. Backend Excel Graph tools already exist. |
| **sharepoint-extension** | SPFx (App Customizer) | React | ESM **+ SPFx toolchain pins TS/bundler** (ESM interop risk) | fetch | proxy (non-tenant-aware today → planned Entra/SP SSO → Zitadel exchange) | SP page-context store (verify) | strict | No. |
| **Webcomponent-Webpart** | SPFx web part | hosts the Lit web component | ESM **+ SPFx toolchain pins** | fetch (delegated to WC) | delegated to hosted WC | delegated | strict | No. Hosts the web component in SharePoint **and** Teams. |
| **bb-slack-integrations** | Node (bolt-js) | none (server) | ESM | fetch (Node) | api-key / service auth | **server-side token store** | n/a (no browser) | No. **Only server-adjacent surface.** No DOM / no `localStorage` / no Office/chrome APIs. 3-second Slack ack deadline. Tenant-mapping is zero-tolerance (0 cross-tenant). |
| **blocky-mobile** | RN / Expo | React (RN) | Metro bundler (not export-map-native like ESM resolvers) | **axios today; RN `fetch`/`ReadableStream` UNSTABLE** | **device (SDK gap)** | `SecureStore` (~2KB item limit — the ~2.5KB token is a known concern) / `AsyncStorage` | n/a | No. Web Crypto needs a **polyfill** (PKCE). Crash-free reality lower than web. |
| **b2b-webcomponents / blocky-chat** | Lit-CDN | **Lit (NOT React)** | ESM, tree-shakeable; ~3.5MB CDN bundle → **size-sensitive** | fetch + `EventSource` today | device | WC-local storage (verify) | host-page CSP | No. **`./react` and `./ui` are IRRELEVANT** — only the framework-agnostic core applies. Mission-2 embedding vehicle. |
| **blocky-frontend** | SPA (browser) | React | ESM (Vite) | fetch | **redirect** (`beginBrowserLogin`/`completeBrowserLogin`) | `localStorage`/`sessionStorage` via adapter | standard web | No. Only surface with **real production RUM baselines**. |
| **bb-integration-example** | Node BFF (Next.js) + raw httpx | React (Next) / server | ESM | httpx (server) / fetch | server holds the bearer token | server store | n/a | No — reference/teaching repo (teaches the raw contracts). **Cautionary tale**: had a live `NEXT_PUBLIC_` token-exposure defect. |
| **Chrome extension** | browser (extension) | React | ESM | fetch | PKCE via `chrome.identity.launchWebAuthFlow` | `chrome.storage` | strict (extension) | Named in README + `src/config.ts` (shares Outlook client ID `373051238587049311`). Adoption unverified — verify in repo. |
| **bb-batch-analyzer** | SPA (browser) | React | ESM (Vite) | fetch | OAuth (redirect/dialog) | `localStorage` (theme key `"bb-theme"`) | standard web | No. Named in README theme table + `src/config.ts` (client ID `373515197228255226`). |
| **bb-dashboard** | SPA (browser) | React | ESM | fetch | OAuth | `localStorage` (theme key `"bb-dashboard-theme"`) | standard web | No. Named in README theme table + `src/config.ts` (caller-specific client ID). |

**Reading the "On the SDK today?" column**: adoption is effectively **Outlook only, everything else 0%**. Semver range-pinning means a breaking change fans out **silently** to whatever range each consumer pins — Outlook's decade-of-minors drift (`^0.7.3` while the SDK was at 0.17.0) is exactly why invariant **C** exists, and why keeping it current is a standing obligation. Do not assume "it compiles here" means "it works there."

---

## Capability gaps the SDK still owes adapters

These are **absent from the SDK today** (verified). Until they land, the affected adapters cannot be fully served by the SDK — do not design a change that assumes they exist, and do not tell an adapter team to "just use the SDK" for these.

| Gap | Status in repo (verified) | Who it blocks | Roadmap |
|---|---|---|---|
| **OAuth device-code flow** | No `device`/device-code code anywhere in `src/` (grep is empty). `./auth` exposes `login`, `beginBrowserLogin`/`completeBrowserLogin`, `exchangeCode`, `refreshTokens` — no device-code grant. | `blocky-mobile`, `b2b-webcomponents`/`blocky-chat` (both use device-code auth in their current stacks) | new work |
| **RN-safe / pluggable transport seam** | Core `./api` calls native `fetch(` directly (e.g. `src/api/messages.ts`, `bots.ts`, `conversations.ts`); streaming parses `ReadableStream<Uint8Array>` in `src/api/blocky-sse.ts`. No `AbortSignal` is threaded through `sendMessage`. `src/react/use-chat-stream.tsx:161` has the enable point commented: `// signal: controller.signal, // ← enable once the SDK threads AbortSignal (WS2)`. | `blocky-mobile` (RN `fetch`/`ReadableStream` unstable → no streaming), plus **true cancellation everywhere** (today `useChatStream().stop()` is best-effort — bumps a run-id, request keeps running; see `docs/react-layer.md` gap #2) | WS2 / WS7 |
| **`AnalyticsAdapter` seam** | **On `main`, unreleased (WS9 — PDEV-6854/6855).** Types exported from `./adapters` (`src/adapters/analytics.ts`: `AnalyticsAdapter` + `AnalyticsEventMap`/`AnalyticsEventName`/…), runtime sink at the **`./analytics`** entry point (`src/analytics/index.ts`: `setAnalyticsAdapter`/`trackEvent`/`trackApiError`/`identifyUser`/`setAnalyticsGroup`/…), plus the opt-in **`./analytics/mixpanel`** leaf (`createMixpanelAdapter`, structurally typed — no dependency added). The SDK core still imports no `Mixpanel`/`Sentry`/`Faro`. `src/auth/login.ts` is the one wired call site (PDEV-6855: the `auth_*` funnel + identity binding). ⚠️ **bb-slack-integrations** (one Node process, many orgs) must omit the process-wide `identify`/`group` from its adapter and rely on per-event identity. | **Every surface** — makes SLO "Part B" telemetry measurable once wired (invariant **E**). The seam emits the standard event taxonomy (`auth_success`/`auth_failed`, `message_send`, `stream_start`/`stream_first_token`/`stream_complete`/`stream_dropped`, `api_error{statusCode,endpoint}` — the typed `AnalyticsEventMap` in `references/telemetry-release-gate.md` §1–2 is the canonical source of truth). | Landed (WS9); per-surface wiring outstanding |

Wiring the `AnalyticsAdapter` (register via `setAnalyticsAdapter` from `@theblockbrain/bb-client-sdk/analytics`) is a **release-gate checklist item on every surface** — nothing ships without both product analytics (Mixpanel) and health telemetry (Sentry + Grafana Faro). See invariant **E** in `/sdk` and `references/telemetry-release-gate.md`.

---

## Per-runtime gotchas that will break a naive change

Grouped by the invariants they enforce (**A** framework-agnostic core, **B** no runtime assumptions, **D** security). Check the group that matches the runtimes your change touches.

### Node — `bb-slack-integrations`, `bb-integration-example` (BFF)
- **No DOM.** No `window`, `document`, `localStorage`, `EventSource`, or Office/chrome globals. Any core code (`./api`, `./auth`, `./settings`, `./text`, `./utils`, `./adapters`, `./config`) that touches a browser global crashes Slack at import (invariant **A/B**).
- **Storage is server-side.** Always go through `StorageAdapter` (a Node key-value/DB store here) — never a global. The interface is already `async` (`get`/`set`/`remove` return Promises), which fits a server store.
- **Auth is api-key / service.** No dialog, no redirect. In api-key mode `AuthContext.userId` is `undefined`, so the **Agentic path is unavailable** (`src/settings/auth-mode.ts` — Agentic is OAuth-only). Don't route Slack through Agentic.
- **3-second Slack ack deadline** and **0 cross-tenant** tolerance. Respect the `orgId` vs `targetOrgId` boundary (invariant **D**) — never put a target tenant's org in `AuthContext.orgId`.
- Web Crypto (PKCE) is present in Node 20+ so `src/auth/pkce.ts` works, but Slack shouldn't be doing PKCE at all.

### React Native / Expo — `blocky-mobile`
- **No Web Crypto.** `src/auth/pkce.ts` calls `crypto.getRandomValues(...)` and `crypto.subtle.digest("SHA-256", ...)`. RN has neither by default → **needs a polyfill** before any PKCE path runs (invariant **B**).
- **`fetch`/`ReadableStream` unstable.** The streaming parser in `src/api/blocky-sse.ts` consumes `ReadableStream<Uint8Array>`; RN's implementation is unreliable. This is *the* real streaming blocker → needs the transport seam (WS2/WS7). blocky-mobile uses **axios** today for a reason.
- **Storage is tiny.** `SecureStore` has a ~2KB item limit; the ~2.5KB token does not fit cleanly — a known concern. Implement `StorageAdapter` with chunking or `AsyncStorage` fallback; never assume unlimited storage.
- **Device-code auth** is required and **the SDK lacks it** (gap above).

### Lit — `b2b-webcomponents` / `blocky-chat` (and the SPFx-hosted web component)
- **Not React.** `./react` and `./ui` are **off-limits** — importing them pulls React into a Lit bundle. Use only the framework-agnostic core (invariant **A**).
- **Size-sensitive** (~3.5MB CDN bundle). Tree-shaking matters: `./api` and `./auth` **must tree-shake with zero React in the graph** — `attw`/`publint` (`npm run check:package`) verify the export map keeps React out. A stray React import in the core silently bloats this bundle.
- Uses `EventSource` on its own side today; don't assume the SDK provides it — the SDK streams via `fetch` + `ReadableStream`.

### SPFx — `sharepoint-extension`, `Webcomponent-Webpart`
- **Strict CSP.** Tight allowlist; anything the core does that dials out unexpectedly will be blocked.
- **Toolchain pins TypeScript and the bundler.** The SPFx toolchain fixes TS/bundler versions → **ESM interop risk** against this ESM-only package. When a change touches types or the export map, re-check that `attw --profile esm-only` still resolves **under the SPFx-pinned TS**, not just the repo's TS.
- Auth today is a **bespoke, non-tenant-aware proxy** (planned Entra/SP SSO → Zitadel exchange) — do not assume standard PKCE state applies here yet.

### Office (browser webview) — Outlook, Word, PowerPoint, Excel
- **Storage is async and size-limited.** `Office.context.roamingSettings` is async and capped. The `StorageAdapter` contract is already async (`Promise`-returning), so honor it — never introduce a synchronous storage assumption (invariant **B**).
- **Dialog-based auth, not popup/redirect.** `IdentityAdapter.launchOAuthFlow` is implemented with `Office…displayDialogAsync`; `getRedirectUri` returns the Office dialog redirect. Don't hardcode a browser redirect path.
- **Strict Office CSP.** Same blast radius as SPFx for unexpected network/eval.
- Outlook's `api.ts` being a **re-export barrel** means an export rename hits it immediately — this is the surface to canary-test first.

---

## Cross-cutting reminders (links, not restated)

- **Invariants A–E** and the security model: `/sdk` (base skill) **§3** — the invariant summaries live inline there (there is no separate `invariants.md`).
- **The injection seams** (`IdentityAdapter`, `StorageAdapter`): `src/adapters/identity.ts`, `src/adapters/storage.ts`.
- **The breakage tripwire**: `src/public-api.contract.test.ts` + `src/__snapshots__/public-api.contract.test.ts.snap` — an undeclared change to any entry point fails the test (14 today).
- **Canary before `latest`**: `canary.yml` (label `release:canary`) — still mandatory. `publish.yml` re-runs the full gate on the tag since PDEV-7001 (SLO E2 closed), but no gate in this repo can prove a **consumer** builds; only the canary does.
- **Telemetry / event taxonomy** (the canonical `AnalyticsEvent` union, identity model, release gate): `references/telemetry-release-gate.md`.
- **Org code-style baseline** (import order, no `any`, early returns, error handling, verification checklist): the org **Code Cleanup & Refactoring** standard.
- **React layer honest gaps** (cancellation, missing hook tests): `docs/react-layer.md`. The `bun:test` legacy is gone — the PKCE state-separation test is now `src/auth/pkce.test.ts` and runs in CI (PDEV-7684).
