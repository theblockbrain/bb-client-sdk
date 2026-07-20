---
name: cross-adapter-safety
description: Use when about to merge, publish, or review ANY change to @theblockbrain/bb-client-sdk — a decision flow + checklist that verifies the change against every runtime, framework, auth flow, and storage seam before it fans out to all adopters. "In every step, verify all cases so it will not break in any adapter."
---

# Cross-Adapter Safety Checklist

> **Inherits from**: `/sdk` — see that skill for the adapter matrix, invariants, and the verification loop. This doc is the **pre-merge gate**; do not duplicate the base content, follow the links.
>
> **Reference docs**: adapter matrix → [`./adapters.md`](./adapters.md) · invariants A–E → the base `/sdk` skill. Baseline code style (import order, no `any`, early returns, error handling) → **Code Cleanup & Refactoring** standard — link, don't restate.
>
> **Dual audience.** SDK maintainers run this before merging to `main`/cutting a tag. Adapter (consumer) developers run the **Phase 5 quick pass** + **Phase 4 canary install** before bumping their SDK range.

This SDK is `@theblockbrain/bb-client-sdk` v0.17.0 — **ESM-only**, published private to GitHub Packages, consumed by **every** BlockBrain Apps surface ("thin surface, thick SDK"). A change that breaks any one adopter is a defect. Semver + range-pinning means a breaking change **fans out silently** — the Outlook add-in pinned at a stale `^0.7.3` (vs 0.17.0) is the cautionary tale. Run these phases **in order**; each phase's answer routes to required checks.

---

## Phase 0 — Baseline gate (always, before anything else)

Run the same gate CI runs (`.github/workflows/ci.yml`), in order. This is the real merge gate under branch protection:

```bash
npm run lint:biome     # biome check .
npm run lint:types     # eslint src (type-aware)
npm run typecheck      # tsc --noEmit
npm test               # vitest run  (includes the public-API contract test)
npm run build          # tsup + tsc -p tsconfig.build.json + copy theme-base.css
npm run check:package  # publint + attw --pack . --profile esm-only
```

If any step fails, stop and fix — later phases assume a green baseline. Then triage blast radius.

---

## Phase 1 — Blast-radius triage

Answer each question. Any "yes" pulls in the linked phase's checks. Cheap changes touch one row; a public streaming-auth change touches all of them.

| # | Does the change touch… | How to tell | If yes → required |
|---|---|---|---|
| 1 | a **public export**? | edits a file re-exported from any `src/**/index.ts` behind a `package.json` `"exports"` subpath (`.`, `./auth`, `./api`, `./settings`, `./utils`, `./adapters`, `./config`, `./prompt`, `./actions`, `./ui`, `./react`) | **Phase 3** (contract test + semver) **and** **Phase 4** (canary) |
| 2 | the **framework-agnostic core**? | edits under `src/api` `src/auth` `src/settings` `src/utils` `src/adapters` `src/prompt` `src/actions` `src/config.ts` | **Phase 2** (runtime audit). Invariant A: core must import **zero React**. |
| 3 | **auth**? | `src/auth/*`, `src/settings/auth-mode.ts`, `src/config.ts` OAuth constants | **Phase 2** + auth sub-checks below + **Phase 5** (auth-flow column) |
| 4 | **streaming / transport**? | `src/api/messages.ts`, `stream-result.ts`, `blocky-sse.ts`, `src/api/agentic/sse.ts`, any `fetch(`/`getReader`/`ReadableStream` | **Phase 2** (transport seam) + **Phase 5** (streaming column) |
| 5 | **types only**? | `export type` / `interface` change, no runtime code | **Phase 3** — the contract test snapshots **types too** (`./adapters` is entirely `export type`), so a type change still trips it. Decide semver. |
| 6 | **React / UI only**? | edits confined to `src/react` or `src/ui` | Skip Lit/Slack in Phase 5 (`./react` + `./ui` are irrelevant to blocky-chat and bb-slack-integrations). Still Phase 3 if exported. |
| 7 | **deps / build / publish**? | `package.json`, `tsup.config`, `tsconfig*.json`, `.github/workflows/*`, `lefthook.yml` | Re-run **Phase 0** `check:package`; confirm ESM-only + peer externalization; see the publish gap note in Phase 4. |

**Auth sub-checks (row 3):**
- `AuthContext.orgId` is the **HOME** org (`x-zitadel-org-id`). Cross-tenant admin passes a separate `targetOrgId` to individual API fns → `?orgId=` query. **Never** put a target tenant's org in `AuthContext.orgId` — this is the tenant-isolation boundary (invariant D; zero cross-tenant tolerance, esp. bb-slack-integrations).
- OAuth `baseUrl` is hardcoded to `OAUTH_BACKEND_URL` (`src/config.ts` → `https://blocky.theblockbrain.ai`); `settings.bbUrl` is **ignored** in OAuth mode (audience pinning). Don't "fix" this to read `bbUrl`.
- Refresh stays **single-flight** via `src/auth/refresh-singleton.ts` — no refresh storms.
- PKCE stays **S256-only** with state/CSRF separation (`test/auth/pkce-state-separation.test.ts`, currently `bun:test` / vitest-excluded — roadmap WS1).

---

## Phase 2 — Runtime-assumption audit (invariant B)

The core must not assume the browser. No direct `window`/`document`/`localStorage`/`sessionStorage`/`fetch`/`EventSource`/`crypto.subtle` in core dirs **except** the sanctioned exceptions below — everything else goes through a `StorageAdapter`/`IdentityAdapter` or a capability check. Run:

```bash
grep -rnE '\b(window|document|localStorage|sessionStorage|navigator|EventSource)\b|crypto\.subtle|\bfetch\(' \
  src/api src/auth src/settings src/utils src/adapters src/prompt src/actions src/config.ts
```

Compare against the **known/sanctioned** hits. A hit **not** on this list is a defect — reroute it through an adapter or capability check.

| Hit | File | Why it's allowed | Adapter impact |
|---|---|---|---|
| `window` / `document` / `sessionStorage` | `src/auth/browser-redirect.ts` | The **only** browser-only module. `beginBrowserLogin`/`completeBrowserLogin` are full-page-redirect helpers for **browser SPAs only** (blocky-frontend). | Non-browser surfaces (bb-slack-integrations Node, blocky-mobile RN device-code) **must NOT import** `./auth`'s redirect helpers. Keep them quarantined here. |
| `crypto.subtle.digest` | `src/auth/pkce.ts` | Web Crypto S256. Present in browsers + Node 20+. | **blocky-mobile (RN) needs a polyfill.** Adding a new `crypto.subtle` call widens that polyfill surface — flag it. |
| `fetch(` | `src/api/*.ts` (conversations, messages, agents, capabilities, tenant-config, transcribe, websearch, …) | Current transport. | **RN `fetch`/`ReadableStream` is unstable** (blocky-mobile) — the streaming blocker. Do **not** add a new hard `fetch`/`ReadableStream`/`getReader` dependency without threading it through the planned **transport seam** (roadmap WS2/WS7). b2b-webcomponents/blocky-chat use EventSource today; SharePoint has a strict CSP. |

**Storage rule:** never read/write a global store. Always go through `StorageAdapter` (`src/adapters/storage.ts`) — it is the seam behind Office `roamingSettings` (async, size-limited), `chrome.storage`, RN `SecureStore` (~2 KB item limit; the ~2.5 KB token is a known concern), and the Slack server-side store.

**React containment (invariant A):** confirm no new React import leaked into the core:

```bash
grep -rnE "from ['\"]react|from ['\"]@tanstack/react-query|useState|useEffect" \
  src/api src/auth src/settings src/utils src/adapters src/prompt src/actions src/config.ts
```

Expect **zero** matches. React may appear only under `src/react` and `src/ui`. `check:package` (attw/publint) verifies `./api` and `./auth` tree-shake with no React in the graph; keep it that way.

---

## Phase 3 — Public-API contract test workflow

`src/public-api.contract.test.ts` snapshots the exported **names — values and types** — of all JS entry points (derived from `package.json` `"exports"`, not hard-coded — 11 today; 12 once `./analytics` lands), against `src/__snapshots__/public-api.contract.test.ts.snap`. An undeclared surface change fails CI.

**When `npm test` reports a contract-snapshot diff:**

1. **Read the diff.** Which entry point? Symbol added, renamed, or removed?
2. **Is it intentional?**
   - **No** → you accidentally changed the surface. Fix the code; do **not** update the snapshot.
   - **Yes** → classify the change:

| Change | Semver | Action |
|---|---|---|
| Added a new export | **minor** (`0.x` → bump minor) | Update snapshot, bump minor. |
| Removed / renamed an export, or changed a type shape consumers depend on | **breaking** | Update snapshot, bump minor per `0.x` convention **and** treat as breaking: **Phase 4 canary is mandatory**, and notify pinned consumers (the stale-Outlook lesson). |
| No surface change (internal only) | none | Snapshot should not have moved — investigate why it did. |

3. **Update the snapshot in the same PR** (the test's own instruction):

   ```bash
   npm test -- -u        # or: npx vitest run -u
   ```

4. **Review the regenerated `.snap`** as part of the diff — a reviewer must see the surface change explicitly. Never `-u` blindly to make CI green.

---

## Phase 4 — Canary protocol (before `latest`)

Any change that reaches Phase 1 rows 1 or 4 (public export or streaming/transport) **must** be canary-tested in a real consumer **before** it ships to `latest`.

1. **Publish a canary.** On the PR, add the **`release:canary`** label (or run `canary.yml` via the Actions tab). The workflow runs a typecheck+build gate, publishes `0.0.0-canary.<sha>` under the **`canary`** dist-tag (never `latest`), and comments the install command on the PR.

2. **Install in a consumer — Outlook first** (`ms-outlook-addin` is the reference adopter, whose `api.ts` is a re-export barrel from this SDK):

   ```bash
   npm install @theblockbrain/bb-client-sdk@0.0.0-canary.<sha>
   # …or the moving tag that always points at the newest canary:
   npm install @theblockbrain/bb-client-sdk@canary
   ```

3. **Build + smoke** the consumer: it must build, typecheck, launch, and exercise the touched path (login → send message → stream → render). For a streaming change, verify first-token and completion; for an auth change, verify login + a tenant-scoped call.

4. **Widen** as risk warrants using the Phase 5 pass — at minimum add one non-React consumer (bb-slack-integrations for Node/no-DOM, or b2b-webcomponents for Lit) when the core changed.

> ⚠ **Cross-repo dispatch is DORMANT.** `canary.yml`'s `notify-consumers` job only runs when `vars.CONSUMER_DISPATCH_ENABLED == 'true'` (needs an org GitHub App; default `GITHUB_TOKEN` can't trigger another repo's workflow — PDEV-6806). Until then, **install the canary in the consumer by hand.**

> ⚠ **Publish gate gap (SLO E2).** `publish.yml` (tag `vX.Y.Z` on `main`) runs **only `typecheck` + `build`** — **not** test / lint / `check:package`. Cutting a release does **not** re-run the full gate; `ci.yml` on `main` is the safety net. So: land the change on `main` green (Phase 0 in CI) **before** tagging, and never fast-follow a tag onto an unverified commit. Flag this on any release PR until the gate is fixed.

> **`file:` link gotcha.** `dist/` is git-ignored and npm does **not** build symlinked `file:` deps. After a fresh clone/pull of this SDK, run `npm run build` **once** before building any linked consumer, or it will resolve stale/missing `dist/`.

---

## Phase 5 — Per-adapter "will this break it?" quick pass

Walk the matrix. Full details in [`./adapters.md`](./adapters.md) — this is the fast trigger table. For each adopter the change could touch, ask the trigger; if it fires, that adopter must be smoke-tested (Phase 4) before `latest`.

| Adopter | Runtime / framework | Trigger — re-verify if the change touches… |
|---|---|---|
| **ms-outlook-addin** | React, Office.js webview | **anything public** — reference adopter + re-export barrel. Note the stale `^0.7.3` pin. Storage = Office `roamingSettings` (async, size-limited). |
| **ms-word-addin** | React, Office.js webview | api types/endpoints, SSE loop, PKCE — active migration target. |
| **ms-powerpoint-addin** / **ms-excel-addin** | React, Office.js (greenfield) | PKCE-dialog auth (reuses Outlook), api endpoints. |
| **sharepoint-extension** | SPFx (React) | **CSP** (no new inline/eval/remote), ESM interop (toolchain-pinned TS/bundler), auth (bespoke proxy → planned Entra/SP SSO→Zitadel). |
| **Webcomponent-Webpart** | SPFx web part hosting the web component | bundle/CSP; anything b2b-webcomponents depends on. |
| **bb-slack-integrations** | Node (bolt-js), **no DOM** | **any browser global** (Phase 2), storage seam, **tenant mapping (0 cross-tenant)**, api-key auth, 3-second Slack ack deadline. Only server-adjacent surface. |
| **blocky-mobile** | React Native / Expo | **`crypto.subtle`** (needs polyfill), **`fetch`/`ReadableStream`** (unstable — transport seam), `StorageAdapter` (SecureStore ~2 KB / AsyncStorage), device-code OAuth (SDK gap). |
| **b2b-webcomponents / blocky-chat** | **Lit (not React)** | core only — **`./react` + `./ui` are irrelevant.** Bundle **size** (tree-shaking; ~3.5 MB CDN bundle), device-code auth + EventSource. |
| **blocky-frontend** | React SPA (browser) | redirect login (`beginBrowserLogin`/`completeBrowserLogin`); the only surface with production RUM baselines. |
| **bb-integration-example** | Next.js BFF + raw httpx | raw API contracts; **no token in `NEXT_PUBLIC_`** (past exposure defect — invariant D). |

---

## Phase 6 — Definition of Done

A change is done only when **all** boxes are checked:

- [ ] **Phase 0 gate green locally** — biome, eslint, typecheck, `npm test`, build, `check:package` all pass.
- [ ] **Blast radius triaged** (Phase 1); every triggered phase completed.
- [ ] **Runtime audit clean** (Phase 2) — no new unsanctioned `window`/`document`/`localStorage`/`fetch`/`EventSource`/`crypto.subtle` in core; **zero React** in the framework-agnostic core.
- [ ] **Contract test resolved** (Phase 3) — snapshot diff is intentional, `-u`'d **in this PR**, reviewed, and semver classified (breaking → Phase 4 mandatory + notify pinned consumers).
- [ ] **Canary smoke-tested** (Phase 4) for public/streaming changes — Outlook first, plus one non-React consumer if the core changed; consumer builds and the touched path works. **Not yet on `latest`.**
- [ ] **Security invariants hold** (invariant D) — tokens never logged (scrub `BBApiError.responseBody`), storage only via `StorageAdapter`, orgId vs `targetOrgId` discipline (0 cross-tenant), OAuth audience pinning intact, `extractJson` still never throws, markdown output sanitized.
- [ ] **Telemetry release-gate acknowledged** (invariant E) — no surface ships to production without **both** product analytics (Mixpanel: Zitadel `sub` as distinct id, org as group, no PII) **and** health telemetry (Sentry + Grafana Faro RUM). The `AnalyticsAdapter` seam is **planned** (**WS9** — not yet on `main`); once it lands, register an adapter via `setAnalyticsAdapter` from `@theblockbrain/bb-client-sdk/analytics` and forward the standard event taxonomy (`auth_success`/`auth_failed`, `message_send`, `stream_start`/`stream_first_token`/`stream_complete`/`stream_dropped`, `api_error{statusCode,endpoint}` — the typed `AnalyticsEventMap` in [`./telemetry-release-gate.md`](./telemetry-release-gate.md) §1) to Mixpanel + Sentry/Faro; wiring it stays a per-surface release-checklist item.
- [ ] **Conventional Commit + branch name** pass lefthook — `type(TICKET-123): …` and `type/TICKET-123/description`.
- [ ] **STATUS/roadmap honesty** — if the change touches a known gap (best-effort cancellation WS2, device-code auth, transport seam WS2/WS7, publish-gate SLO E2, bun:test legacy WS1), update `src/react/STATUS.md` rather than silently papering over it.
