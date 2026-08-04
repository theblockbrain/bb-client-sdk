---
name: sdk
description: Use when developing, reviewing, or migrating anything in @theblockbrain/bb-client-sdk or adopting it in an adapter/surface — loads the SDK's invariants, adapter matrix, security + telemetry gates, and the per-change verification loop.
---

# bb-client-sdk — base skill

This is the entry point for **any** work in `@theblockbrain/bb-client-sdk` (repo root: `bb-client-sdk`) — maintaining it, reviewing a change, or adopting/migrating a consumer onto it. Load it first; then load the phase-based sub-skill for the task (see [Sub-skills](#7-sub-skills--references)).

**Dual audience.** Written for BOTH SDK maintainers and adapter (consumer) developers. Where guidance differs, it says so.

Package: `@theblockbrain/bb-client-sdk` · v0.17.0 · `"type": "module"` (**ESM-only**) · published to **GitHub Packages** (private, `https://npm.pkg.github.com`, `access: restricted`). Runtime dep: `marked` only. Optional peers (React consumers only): `react ^19`, `@tanstack/react-query ^5`.

---

## 1. What this SDK is — "thin surface, thick SDK"

Every BlockBrain "Apps" surface (Outlook add-in, SharePoint, Slack, mobile, web components, web SPA…) is meant to be a **thin** shell. The **thick** shared logic — auth/PKCE, the API contracts, streaming, settings, parsing — lives here, once, so a surface only wires its runtime-specific bits (storage, identity dialog, DOM) through injection seams and consumes the rest.

That fan-out is the whole design constraint: **this SDK is consumed by React apps, a Lit web component, and a Node (Slack) backend alike.** So the core cannot assume React or even a browser.

> **Invariant A — framework-agnostic core.** The core entry points (`./api`, `./auth`, `./settings`, `./text`, `./utils`, `./adapters`, `./config`) MUST stay React-free and, where possible, DOM-free. Only `./react` and `./ui` may import React. `./api` and `./auth` must tree-shake with **zero React in the graph** (`publint` + `attw` verify the export map).
>
> Practical rule for **non-React consumers** (Slack, Lit): import the **specific subpath** (`@theblockbrain/bb-client-sdk/api`), never the root barrel `"."` — `src/index.ts` re-exports `./ui` (which imports React), so the root barrel pulls React into the graph. `./react` is intentionally NOT in the root barrel.

---

## 2. Layer map — entry points

Declared in `package.json` `"exports"` → source dir. **18 JS entry points** (plus the CSS asset subpath, which the contract test skips). The three newest — `./agentic`, `./analytics` and `./analytics/mixpanel` — are on `main` but **not in a published release yet** (last tag `v0.17.0` predates them). The public-API contract test derives its list from `package.json#exports` and snapshots every entry point.

| Entry point | Source | What lives there | Who may consume it |
|---|---|---|---|
| `.` | `src/index.ts` | Root barrel — re-exports the core **and `./ui`** (so it pulls React). NOT `./react`. | React surfaces only (pulls React via ui) — non-React consumers use subpaths |
| `./api` | `src/api/` | bots, conversations, messages, agents, capabilities, tenant, tenant-config, websearch, transcribe, notes, introspect; `errors.ts` → `BBApiError`/`isBBApiError`; `headers.ts` + `_auth-headers.ts`; `blocky-sse.ts` (Blocky parser `new_token`→`message_ready`); `stream-result.ts` (`MessageStream {textDeltas, final}`); `messages.ts` (`sendMessage` + Blocky↔Agentic routing on the conversation's agent); `url.ts` | **All** runtimes (framework-agnostic) |
| `./agentic` | `src/api/agentic/` | The agent-execution protocol against `POST /v2/api/agents/:agentId/stream`, published as its own subpath (also re-exported from `./api`): `client.ts` (`callAgenticStream`, `buildAgenticStreamUrl`, `autoApproveResolver`, the approval + suspend/resume loop, `ApprovalResolver`/`ApprovalResult`/`SuspendContext`), `sse.ts` (`parseAgenticStream`, `collectTextFromStream`), `types.ts` (the `AgenticSseFrame` union + `isTextDeltaFrame`/`isToolCallApprovalFrame`/`isToolCallSuspendedFrame`), `headers.ts` (`agenticHeaders`) — 26 exports. **This is what an approval UI imports.** | **All** runtimes (framework-agnostic; needs `fetch` + `ReadableStream`) |
| `./auth` | `src/auth/` | `login`, `pkce` (RFC 7636 S256 via Web Crypto), `tokens` (`exchangeCode`/`refreshTokens`/`isTokenExpired`), `refresh-singleton` (`createRefreshGuard`, single-flight), `browser-redirect` (`beginBrowserLogin`/`completeBrowserLogin`), `jwt` (`extractProfile`, `decodeJwtPayload`) | **All** runtimes (Web Crypto → needs polyfill in RN) |
| `./settings` | `src/settings/` | `auth-mode.ts`: `AuthContext {baseUrl, token, orgId, mode:'oauth'\|'api-key', userId?}`; `getAuthContext(settings, tokens, {oauthBaseUrl?, userId?})`; `inferAuthMode()`; `hasUsableAuth()`; `schema.ts` | **All** runtimes |
| `./text` | `src/text/` | `extractJson` (returns `T\|null`, **never throws**) + `repairUnescapedQuotes`; `extractCode`. Split out of `./utils` in PDEV-7684. | **All** runtimes |
| `./utils` | `src/utils/` | `createLock` only, after PDEV-7684. **Deletion candidate** — no caller anywhere checked. | **All** runtimes |
| `./adapters` | `src/adapters/` | **No longer type-only** (PDEV-7724): carries the runtime halves of the host ports — `createWebStorageAdapter`, `createWebCryptoAdapter` + `setCryptoAdapter`/`getCryptoAdapter`, `createHostCapabilityRegistry` + `routeToolCall`, `setFlagAdapter`/`isFeatureEnabled`. Still React-free and DOM-free at import time. `IdentityAdapter {getRedirectUri, launchOAuthFlow}`, `StorageAdapter {get, set, remove}` — the injection seams that keep surfaces thin. Also `AnalyticsAdapter` + `AnalyticsEventMap`/`AnalyticsEventName`/`AnalyticsEventProps`/`AnalyticsIdentity`/`AnalyticsErrorContext` (the telemetry seam). | **All** runtimes (each surface implements them) |
| `./adapters/office` | `src/adapters/office.ts` | **Opt-in leaf.** `createOfficeIdentityAdapter(config)` — the Office-dialog `IdentityAdapter`: `displayDialogAsync` + `messageParent` courier, so the PKCE verifier never crosses the dialog boundary (PDEV-7684, replaces the CWE-200 `state`-encoded verifier). `OfficeGlobal` is a **structural** type over the slice of `Office` used, so the SDK takes no Office.js dependency. | Office add-ins (Outlook / Word / PowerPoint / Excel) |
| `./analytics` | `src/analytics/index.ts` | Runtime side of the `AnalyticsAdapter` seam: `setAnalyticsAdapter`/`getAnalyticsAdapter`/`resetAnalyticsAdapter`, the safe sink `trackEvent`/`captureError`/`trackApiError`/`flushAnalytics` (no-op when no adapter is registered, never throws into the caller), the guarded identity binders `identifyUser`/`setAnalyticsGroup` (process-wide — a multi-tenant server adapter omits `identify`/`group` so they no-op), and re-exports the analytics types from `./adapters`. Type-only imports → React-free + DOM-free (invariants A + B). | **All** runtimes (each surface registers an adapter) |
| `./analytics/mixpanel` | `src/analytics/mixpanel.ts` | **Opt-in leaf.** `createMixpanelAdapter(client, config)` — super-props, tenant grouping, a PII denylist and a consent gate. `MixpanelClient` is a **structural** type over the `mixpanel-browser` methods used, so the SDK takes **no** analytics dependency and the core only pulls this in if a surface imports the subpath. | Surfaces that chose Mixpanel (they own the `mixpanel-browser` instance) |
| `./telemetry` | `src/telemetry/` | The event **taxonomy** + consent plumbing: `CORE_EVENT_NAMES`/`CoreEventMap`, the closed vocabularies (`CHAT_TOPICS`, `AGENT_KINDS`, `BOT_KINDS`, `CLIENT_ROUTES`, `CONVERSATION_ENTRY_POINTS`, `BACKEND_ACTION_TYPES`), their runtime coercers, and `ConsentGate`/`ConsentSource`/`ConsentState` + the `DENIED_PROPERTY_KEYS` PII denylist (PDEV-7011). Distinct from `./analytics`, which is the **sink**. | **All** runtimes |
| `./telemetry/cookiebot` | `src/telemetry/cookiebot.ts` | **Opt-in leaf.** `createCookiebotConsentSource(options)` — a `ConsentSource` over Cookiebot. `CookiebotLike` is a **structural** type, so the SDK takes no Cookiebot dependency. | Surfaces using Cookiebot for consent |
| `./config` | `src/config.ts` | `AUTH_AUTHORITY`, `OAUTH_BACKEND_URL`, `AGENTIC_BASE_URL`, `TOKEN_ENDPOINT`, `AUTHORIZE_ENDPOINT`, `AUTH_SCOPES` | **All** runtimes |
| `./ui` | `src/ui/` | **React-only.** `useTheme` + `nextThemeMode`, `markdown.ts` (marked), `time.ts`. **One** theme mechanism: `<html data-theme="light\|dark\|system">`, written verbatim so blokkit's CSS resolves `system` (PDEV-7000). No toggle component — default-palette classes break under blokkit's `tailwind-reset.css`. | React surfaces only |
| `./react` | `src/react/` | **React-only.** React Query data layer: `provider.tsx`, `keys.ts` (`bbKeys`), `queries.ts`, `mutations.ts`, `use-chat-stream.tsx` (`useChatStream`). Test-first; known gaps in [`docs/react-layer.md`](../../../docs/react-layer.md) | React surfaces only |
| `./ui/theme-base.css` | `src/ui/theme-base.css` | Shared CSS (asset subpath, not a module). Tailwind v4 consumers add `@source "../node_modules/@theblockbrain/bb-client-sdk/dist"` | React surfaces using the theme |

**`./ui` and `./react` are IRRELEVANT to Lit (blocky-chat) and Node (Slack)** — only the framework-agnostic core applies to them.

---

## 3. The five prime invariants

Every change is judged against all five. Each is expanded in the reference docs cross-linked from its bullet and in [Sub-skills + references](#7-sub-skills--references).

- **A — Framework-agnostic core.** Core stays React-free; only `./react`/`./ui` import React. `./api`/`./auth` must tree-shake with zero React. Non-React consumers import subpaths, not the root barrel. Verified by `check:package` (`publint` + `attw`).
- **B — No runtime assumptions.** Don't assume the browser: no direct `window`/`document`/`localStorage`/`fetch`/`EventSource`/Web-Crypto in the core without an adapter or capability check. Storage is **always** via `StorageAdapter`; Web Crypto needs an RN polyfill; `fetch`/`ReadableStream` is unreliable in RN (the transport seam, WS2/WS7). Checked per runtime in the cross-adapter safety pass → [references/cross-adapter-safety.md](references/cross-adapter-safety.md).
- **C — Verify all adapters.** Every change is checked against the adapter matrix (runtime/framework/auth-flow/storage/CSP): does it break any? A public-export change must pass the contract test **and** be canary-tested in a consumer (Outlook) BEFORE `latest`. Outlook once sat on a `^0.7.3` pin while the SDK was at 0.17.0 — ten minor eras of silent semver fan-out, the cautionary tale. It is current again (`^0.17.0`); keeping it there is what makes it a usable canary. → [references/adapters.md](references/adapters.md), [references/cross-adapter-safety.md](references/cross-adapter-safety.md).
- **D — Security in every layer.** Tokens never logged (scrub `BBApiError.responseBody`), only in secure storage via the adapter, never in a bundle or `NEXT_PUBLIC_` var. PKCE S256 + state/CSRF + redirect allowlist + nonce. Refresh single-flight (`createRefreshGuard`). HTTPS + audience pinning (`OAUTH_BACKEND_URL` hardcoded). Multi-tenant: `orgId` vs `targetOrgId` discipline, **0 cross-tenant leakage**. `extractJson` never throws; sanitize markdown (XSS). Minimal deps + restricted registry + least-scope PAT + secret-scan. → [references/security.md](references/security.md).
- **E — Instrument every surface (HARD release gate).** NOTHING ships to production without BOTH (1) product analytics (Mixpanel: activation/funnel/retention; Zitadel `sub` as distinct id, org as group, **no PII**) AND (2) health telemetry (Sentry + Grafana Faro RUM: crash-free + error rate). The SDK exposes the **`AnalyticsAdapter`** seam (peer of Storage/Identity) with a typed event taxonomy (`AnalyticsEventMap` / `AnalyticsEventName`: `auth_success`/`auth_failed`, `message_send`, `stream_start`/`stream_first_token`/`stream_complete`/`stream_dropped`, `api_error{statusCode,endpoint}`). **The seam is on `main`** (WS9 — PDEV-6854/6855), **not yet in a published release** (last tag `v0.17.0` predates it): register an adapter at surface startup via `setAnalyticsAdapter` (from `@theblockbrain/bb-client-sdk/analytics`) implementing the `AnalyticsAdapter` type (from `@theblockbrain/bb-client-sdk/adapters`), or take the ready-made `createMixpanelAdapter` from `@theblockbrain/bb-client-sdk/analytics/mixpanel`. **`src/auth/login.ts` is the only wired call site** (PDEV-6855): `auth_started`/`auth_success`/`auth_failed` plus identity binding (`identifyUser`/`setAnalyticsGroup`) on success; see `references/telemetry-release-gate.md` §1. `api_error` (via `trackApiError`), `stream_*`, and `token_refresh` are still to be wired at their call sites. Shipping the seam did not lift the gate — it made it enforceable: each surface STILL must register an adapter forwarding to Mixpanel + Sentry/Faro, and that remains a release-gate checklist item on every surface. → [references/telemetry-release-gate.md](references/telemetry-release-gate.md).

---

## 4. Adapter roster

This SDK fans out to all of these; a change that breaks any one is a defect. Full matrix (runtime, framework, auth flow, storage, CSP, streaming, version pin) → [references/adapters.md](references/adapters.md).

| # | Consumer | Runtime / framework | Notes |
|---|---|---|---|
| 1 | ms-outlook-addin | React, Office.js webview | **Reference adopter**, pins `^0.17.0` (current with the last published tag). Canary target. |
| 2 | ms-word-addin | React, Office.js webview | Hand-rolls ~2,685 LOC; migration target. |
| 3 | ms-powerpoint-addin | React, Office.js (greenfield) | Reuses Outlook PKCE-dialog auth. |
| 4 | ms-excel-addin | React, Office.js (greenfield) | Backend Excel Graph tools exist. |
| 5 | sharepoint-extension | SPFx (React) | **Strict CSP**; toolchain-pinned TS/bundler (ESM interop risk). |
| 6 | Webcomponent-Webpart | SPFx web part | Hosts the web component in SharePoint + Teams. |
| 7 | bb-slack-integrations | **Node (bolt-js)** | No DOM/localStorage/Office. Server token store; api-key/service auth. 3s ack; 0-tolerance tenant mapping. |
| 8 | blocky-mobile | React Native / Expo | axios today; RN fetch/ReadableStream unstable; Web Crypto polyfill; SecureStore ~2KB limit vs ~2.5KB token; device-code flow (SDK lacks it — gap). |
| 9 | b2b-webcomponents / blocky-chat | **Lit** (not React) | `./react`+`./ui` irrelevant. Device-code + EventSource; ~3.5MB CDN bundle → tree-shaking matters. |
| 10 | blocky-frontend | React SPA | Full-page redirect login; only surface with real RUM baselines. |
| 11 | bb-integration-example | Next.js BFF (teaching) | Server holds bearer; had a `NEXT_PUBLIC_` token-exposure defect (cautionary tale). |

Also named in the README: a Chrome extension (`chrome.storage`/`chrome.identity` adapters), `bb-batch-analyzer`, `bb-dashboard`.

---

## 5. THE VERIFICATION LOOP — run for EVERY change

This mirrors `ci.yml` (the real merge gate under branch protection: `lint:biome → lint:types → typecheck → test → build → check:package`). Run it locally on the Node version in `.nvmrc` (Node 24) before pushing.

| # | Step | Command | Notes |
|---|---|---|---|
| 1 | Typecheck | `npm run typecheck` | `tsc --noEmit` over all of `src`. |
| 2 | Lint (Biome) | `npm run lint:biome` | `biome check .` (pre-commit hook runs this on staged files). |
| 3 | Lint (ESLint, type-aware) | `npm run lint:types` | `eslint src` — typescript-eslint + react-hooks + `@tanstack/eslint-plugin-query`. (`npm run lint` = 2+3.) |
| 4 | Test | `npm test` | `vitest run` (jsdom + `@testing-library/react`). Coverage: `npm run test:coverage`. |
| 5 | **Public-API contract test** | (runs inside step 4) | `src/public-api.contract.test.ts` snapshots exports (values **and** types) of all current entry points (16 today). An undeclared surface change fails here. To change the API **intentionally**: update the snap in the same PR (`npx vitest -u`), treat as a breaking change, bump semver, and canary first. |
| 6 | Build | `npm run build` | `tsup` + `tsc -p tsconfig.build.json` (dts) + copy `theme-base.css`. |
| 7 | Package contract | `npm run check:package` | `publint` + `attw --pack . --profile esm-only`. Guards Invariant A (ESM-only, subpath resolution, no React leak into core entries). |
| 8 | Cross-adapter safety pass | (manual) | Walk the change through the adapter matrix. Does it touch a browser/DOM/fetch/storage/CSP assumption? A public-export change → canary in Outlook (add the `release:canary` label) BEFORE `latest`. → [references/cross-adapter-safety.md](references/cross-adapter-safety.md). |
| 9 | Telemetry-gate check | (manual) | If the change ships user-facing behavior on a surface, confirm the Mixpanel + Sentry/Faro wiring for the affected events still holds (Invariant E). → [references/telemetry-release-gate.md](references/telemetry-release-gate.md). |

**`dist/` is git-ignored** and npm does NOT run `build` for `file:` symlinked deps — after a fresh clone/pull, run `npm run build` here once before building a linked consumer.

---

## 6. Coding standards

Baseline code-style rules (import order, no `any`, early returns over deep nesting, no nested ternaries, typed error handling, the verification checklist) live in the org standard — **do not restate them, follow them**: the org **Code Cleanup & Refactoring** standard.

SDK-specific governance on top of that:

- **ESM-only.** `"type": "module"`; no CJS build. Use `.js` extensions in relative imports (as `src/index.ts` does). `check:package` runs `attw --profile esm-only`.
- **Node 24.** Pinned in `.nvmrc`; `engines.node >= 24`. CI and publish both key off `.nvmrc`.
- **Conventional Commit scoped by a Jira ticket** (`commit-msg` hook, lefthook): `feat(PDEV-123): …` / `fix(PDEV-45): …`. Merge/Revert exempt.
- **Branch name** `type/TICKET-123/description` (`pre-push` hook): e.g. `feat/PDEV-123/react-query-layer`. `main` + `release*` exempt.
- **No `any`, typed errors:** every `./api` call throws `BBApiError` (`statusCode`, `endpoint`, `responseBody`) on non-2xx — handle with `isBBApiError(err)` / `err.statusCode` (README: `401` → re-auth, `503` → not configured). Never log `responseBody` raw (may carry tokens — Invariant D).
- **Fix the diagnostic, never silence it.** `biome-ignore`, `eslint-disable`, `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`, and `as any`/`as unknown as T` casts are **last resorts, not tools**. A lint or type error is information about the code — resolve the underlying issue instead. Even an `ℹ`-level Biome diagnostic that exits 0 counts: a clean `npm run lint` is the standard. Before reaching for a suppression, restructure. If a rule genuinely must be waived, that is a **config decision** in `biome.json`/`eslint.config.js` with a written rationale — reviewable in one place — not an inline comment scattered through `src/`. Any suppression that does survive review must name the rule and give a reason on the same line, and a reviewer may ask for it to be removed. Current inventory to work down, not to imitate: `src/api/stream-result.ts:40,100,130`. (`src/ui/useTheme.ts`'s pair came off the list in PDEV-7000 — the one-shot mount effect became an effect keyed on `mode`, which needs no suppression.)
- **Server-supplied enums: closed type for OUR use, open type on the wire.** When a backend
  defines a fixed set of string values (an SSE frame's `code`, a status, a kind), declare the
  closed union — it is the contract, it gives autocomplete, and it lets a consumer write
  `Record<TheUnion, Copy>` so adding a value is a compile error where it matters. But **the field
  that holds a value read off the wire must be the open form**, `TheUnion | (string & {})`:

  ```ts
  export type AgenticErrorCode = "TOOL_EXECUTION_FAILED" | "MASTRA_ERROR" | …;   // the known set
  export type AgenticErrorCodeValue = AgenticErrorCode | (string & {});          // what arrives
  interface StreamErrorData { code: AgenticErrorCodeValue }                      // wire-facing
  ```

  Why: the SDK ships independently of the backend, and nothing validates these values —
  `parseSseDataLine` casts parsed JSON straight to the frame union. A closed union on a wire
  field is a promise the runtime does not keep: a consumer writes an exhaustive `switch` with no
  `default`, TypeScript agrees it is exhaustive, the server adds `RATE_LIMITED`, and the new code
  is silently dropped. Bare `string` is also wrong — it throws away the contract and the
  autocomplete, and it is what reviewers (rightly) flag. The open union is the honest middle.
  Where a value must be narrowed for real, **coerce at runtime with a fallback** rather than
  asserting — `coerceChatTopic` (`src/telemetry/taxonomy.ts`) maps anything unrecognised to
  `other`. Same rule, enforced instead of declared.
- **Functional-first.** Prefer pure functions over stateful helpers; immutable data over in-place mutation (`map`/`filter`/`reduce` and spreads over `push`/index assignment/`splice`); expressions and early returns over accumulator variables; `readonly` / `as const` on anything not meant to change (the SDK already does this for `AUTH_SCOPES`, `LoginOptions.scopes`, adapter trait records). Where the runtime forces imperative code — SSE reader loops, `AbortSignal` plumbing, the process-wide analytics adapter, React effects — keep the mutation **local and contained** behind a pure boundary, exactly as `parseAgenticStream` wraps its reader loop in an `AsyncIterable` and `createRefreshGuard` hides its in-flight promise. Never export a mutable binding; never mutate a caller's object or an argument.

---

## 7. Sub-skills + references

Load the phase-based sub-skill that matches the task. Each inherits from this base (adapter matrix, invariants, verification loop) — it links back rather than duplicating.

| Sub-skill | Use when |
|---|---|
| [sdk-auth](../sdk-auth/SKILL.md) | Touching auth/PKCE/tokens/refresh/`AuthContext`/`getAuthContext`, or wiring a surface's `IdentityAdapter`/`StorageAdapter` + auth flow (redirect / dialog / device-code). |
| [sdk-streaming](../sdk-streaming/SKILL.md) | Touching `sendMessage` routing, `MessageStream`, Blocky SSE (`blocky-sse.ts`) or Agentic streaming, `useChatStream`, cancellation / the transport (AbortSignal) seam. |
| [sdk-endpoint](../sdk-endpoint/SKILL.md) | Adding or changing an `./api` endpoint (headers, tenant/`targetOrgId`, errors) and its optional `./react` query/mutation + cache keys. |
| [sdk-release](../sdk-release/SKILL.md) | Cutting a version, running the canary flow, or reasoning about the publish gate. ⚠ **Known gap:** `publish.yml` runs ONLY typecheck + build — NOT test/lint/`check:package`; `ci.yml` on `main` is the safety net (SLO E2 target: CI + publish both gated on tests). |

**References** (deep detail, linked above):

| Doc | Contents |
|---|---|
| [references/adapters.md](references/adapters.md) | Full adapter matrix — runtime, framework, auth flow, storage, CSP, streaming, version pin per consumer. |
| [references/cross-adapter-safety.md](references/cross-adapter-safety.md) | The per-change cross-adapter safety pass + the canary-before-`latest` procedure. |
| [references/security.md](references/security.md) | Invariant D in depth — token hygiene, PKCE/CSRF, single-flight refresh, tenant isolation, XSS, supply chain, tools (biome/eslint, publint/attw, contract test, npm audit/Dependabot, gitleaks, Sentry, Faro, Mixpanel, optional CodeQL). |
| [references/telemetry-release-gate.md](references/telemetry-release-gate.md) | Invariant E in depth — the `AnalyticsAdapter` seam (WS9), the typed `AnalyticsEventMap` taxonomy + identity model, and the release-gate Definition of Done each surface wires. |
| [references/release-and-versioning.md](references/release-and-versioning.md) | Release + versioning in depth — semver policy for the public API, the canary flow, the publish gate and its known gap (`publish.yml` runs only typecheck + build), and the version-pin fan-out risk per consumer. |
