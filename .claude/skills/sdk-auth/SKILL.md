---
name: sdk-auth
description: Use when changing anything under ./auth or ./settings in bb-client-sdk — PKCE, login, token exchange/refresh, the refresh single-flight, browser-redirect, JWT decoding, AuthContext, or auth modes. Security-critical.
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# sdk-auth — changing `./auth` and `./settings`

> **Inherits from**: `/sdk` — see that skill for the adapter matrix, invariants, and verification loop. Do not duplicate it here; this sub-skill is the auth-specific overlay.

Auth is the highest-blast-radius area of the SDK. It fans out to **every** surface, every runtime, and every tenant, and a mistake here is a security incident, not a bug. The `./auth` and `./settings` code is **framework-agnostic core** (invariant A): Slack (Node, no DOM) and blocky-chat (Lit) import it, so it must not assume the browser (invariant B). Treat this whole subskill as security-critical (invariant D).

**Dual audience.** SDK maintainers editing `src/auth/**` and `src/settings/**`, AND adapter (consumer) developers wiring an `IdentityAdapter` / `StorageAdapter` and deciding which auth flow to use. Consumer-facing notes are marked **[consumer]**.

Baseline code style (import order, no `any`, early returns, error handling, verification): the org **Code Cleanup & Refactoring** standard. Follow it; this file adds only the auth-specific rules.

**Follow these phases exactly.**

---

## Phase 1 — Map the change to the real files (Read before editing)

Read the file(s) you intend to touch before writing anything. Do not edit from memory — the security-relevant behaviour lives in comments and small guards that are easy to regress.

| File | Owns | Key symbols | Runtime constraint |
|------|------|-------------|--------------------|
| `src/auth/pkce.ts` | PKCE primitives (RFC 7636, S256) | `generateVerifier`, `generateStateNonce`, `generateChallenge`; **deprecated** `encodePKCEState`/`decodePKCEState` | Web Crypto: `crypto.getRandomValues`, `crypto.subtle.digest("SHA-256")`. Needs a polyfill in RN. No DOM. |
| `src/auth/login.ts` | Adapter-driven PKCE flow **+ the auth telemetry funnel** | `login(identity, options)` → `LoginResult`; `LoginOptions.clientId` (required, no default). Emits `auth_started` / `auth_success{latencyMs}` / `auth_failed{stage}` and binds identity via `identifyUser`/`setAnalyticsGroup` (PDEV-6855) | DOM-free; delegates the browser hop to `IdentityAdapter.launchOAuthFlow`. Telemetry is fire-and-forget through the sink — it must stay unable to alter `login()`'s behaviour. |
| `src/auth/browser-redirect.ts` | Full-page-redirect PKCE | `beginBrowserLogin`, `completeBrowserLogin`; `BrowserRedirectOptions`, `BrowserLoginResult` | **BROWSER-ONLY**: touches `window.location`, `sessionStorage`, `window.history`, `document.title`. |
| `src/auth/tokens.ts` | Code exchange + refresh + expiry | `exchangeCode`, `refreshTokens`, `computeExpiration`, `isTokenExpired(expMs, leadMs=60_000)`; `TokenResult` | Uses global `fetch` directly (no transport seam here yet). Browsers + Node 18+; plain POST works in RN. |
| `src/auth/refresh-singleton.ts` | Single-flight refresh guard | `createRefreshGuard(refreshFn)` → `{ refresh(), isInflight() }` | Pure; shares one in-flight promise. Do not bypass. |
| `src/auth/jwt.ts` | Client-side ID-token decode | `decodeJwtPayload`, `extractOrgIdFromClaims`, `extractProfile`; `Profile` | No signature verification (server verifies). Returns `null`/empty on malformed input — must not throw. |
| `src/utils/jwt.ts` | Access-token `sub` reader | `subFromAccessToken` → `string \| null` | Feeds `getAuthContext` userId auto-derivation. Lives under `./utils`, not `./auth`. |
| `src/settings/auth-mode.ts` | Auth mode + context | `AuthContext`, `AuthMode`, `OAuthTokens`, `inferAuthMode`, `getAuthContext`, `hasUsableAuth` | DOM-free. `getAuthContext` is where audience pinning + orgId discipline live. |
| `src/settings/schema.ts` | Settings shape | `Settings`, `DEFAULTS` | `bbUrl` default = `OAUTH_BACKEND_URL`. |
| `src/config.ts` | Endpoints + scopes | `AUTH_AUTHORITY`, `OAUTH_BACKEND_URL`, `TOKEN_ENDPOINT`, `AUTHORIZE_ENDPOINT`, `AUTH_SCOPES` | Hardcoded to prod audience — see Phase 2. |
| `src/adapters/identity.ts` / `storage.ts` | The injection seams | `IdentityAdapter {getRedirectUri, launchOAuthFlow}`, `StorageAdapter {get,set,remove}` (all async) | The seam that keeps surfaces thin — never inline a concrete impl into core. |

Barrels that re-export the public surface: `src/auth/index.ts`, `src/settings/index.ts`. Any add/rename/remove there is a **public-export change** → Phase 5 contract test.

---

## Phase 2 — Honor the auth invariants (non-negotiable)

Check every one against your diff. A "no" is a defect, not a tradeoff.

- **S256 only.** `generateChallenge` must stay SHA-256 → base64url; the authorize URL must set `code_challenge_method=S256` (see `login.ts` / `browser-redirect.ts`). Never emit `plain`. Never `crypto.randomUUID()` for the verifier — see the comment in `pkce.ts` (36 chars + hyphens is non-compliant).
- **State/CSRF — verifier NEVER in the URL.** `state` is an independent nonce (`generateStateNonce`), unrelated to the verifier. The verifier lives in local scope (`login`) or `sessionStorage` keyed by the nonce (`browser-redirect`). The deprecated `encodePKCEState`/`decodePKCEState` put the verifier in `state` — that is CWE-200; do not reintroduce it or call it from internal code. The round-trip guards (`returnedState !== state`; "no stored verifier for nonce") must stay. The regression test in Phase 5 exists to catch exactly this.
- **Single-flight refresh — no storms.** Concurrent expired-token callers must share one refresh via `createRefreshGuard`. Do not add a second refresh path that skips the guard; do not `await refreshTokens(...)` directly from multiple call sites.
- **Audience pinning.** OAuth tokens are only valid against `auth.theblockbrain.ai` / `OAUTH_BACKEND_URL`. In `getAuthContext`, OAuth-mode `baseUrl` is hardcoded to `OAUTH_BACKEND_URL` and **`settings.bbUrl` is intentionally ignored**. `bbUrl` is honored only in api-key mode. Keep `TOKEN_ENDPOINT`/`AUTHORIZE_ENDPOINT` defaulting to `AUTH_AUTHORITY`. The option overrides (`oauthBaseUrl`, `tokenEndpoint`, `authorizeEndpoint`) exist for tests — their defaults must stay pinned to prod.
- **`orgId` vs `targetOrgId`.** `AuthContext.orgId` = the user's **HOME** org (`settings.bbOrgId`), sent as `x-zitadel-org-id`. Cross-tenant admin operations pass a **separate** `targetOrgId` to individual `./api` functions (→ `?orgId=`). **Never** put a target tenant's org into `AuthContext.orgId`. This is a zero-tolerance isolation boundary (0 cross-tenant leakage).
- **`userId` (sub) presence.** OAuth mode populates `userId` from `config.userId` or `subFromAccessToken(accessToken)` — required for the Agentic path (`resourceId`). api-key mode has **no** `userId`, so Agentic is unavailable there. Do not fabricate a `userId` in api-key mode.
- **Decode ≠ verify.** `jwt.ts` / `utils/jwt.ts` decode without signature verification (server verifies). Never make a trust/authorization decision client-side on a decoded claim; `sub` is only a server-checkable hint.
- **Auth telemetry stays PII-free and non-behavioural** (invariant E + D). `login()` emits only the coarse `stage` label (`launch`/`parse`/`exchange`) on failure — **never** the error message, `error_description`, `code`, `state`, `verifier`, or a token. Identity is the Zitadel `sub` + org id, nothing else. Emission goes through the sink (`trackEvent` / `identifyUser` / `setAnalyticsGroup`), which no-ops without an adapter and swallows adapter faults, so a broken adapter can never change `login()`'s result or the error it re-throws. Keep it that way: no `await` on telemetry, no branching on it, and the original error re-thrown unchanged. → [`../sdk/references/telemetry-release-gate.md`](../sdk/references/telemetry-release-gate.md) §1.

---

## Phase 3 — Cross-runtime auth (do not break one flow fixing another)

The four flows and the seams each uses. Changing one flow must not regress the others — verify against the adapter matrix (`../sdk/references/adapters.md`).

| Flow | Entry point | Seam | Adapters that use it |
|------|-------------|------|----------------------|
| **PKCE via dialog** | `login(identity, options)` | `IdentityAdapter` (dialog opens authorize URL, returns redirect URL) | ms-outlook / word / powerpoint / excel add-ins (Office `displayDialogAsync`); Chrome ext (`chrome.identity`) |
| **Full-page redirect** | `beginBrowserLogin` / `completeBrowserLogin` | `window` + `sessionStorage` (built in) | blocky-frontend (React SPA) |
| **Device-code** | **GAP — not built in the SDK** | — | blocky-mobile (RN/Expo), b2b-webcomponents / blocky-chat (Lit) need it. Do **not** claim it exists; scope it as roadmap if asked to add it. |
| **api-key / service** | `getAuthContext` → `mode:"api-key"` (from `settings.bbToken`) | Server-side token store | bb-slack-integrations (Node); any api-key consumer. No `userId` → no Agentic. |

Cross-runtime rules:

- **Web Crypto (PKCE).** `pkce.ts` uses `crypto.getRandomValues` + `crypto.subtle.digest`. Present in browsers + Node 20+ (repo is Node 24). **RN needs a polyfill** (`react-native-get-random-values` + a SubtleCrypto polyfill) — blocky-mobile. Don't add a new crypto call without confirming the polyfill story.
- **Keep browser-only code inside `browser-redirect.ts`.** `window`/`sessionStorage`/`document`/`history` may appear **only** there. If a refactor pulls any of them into `login.ts`, `tokens.ts`, `pkce.ts`, `jwt.ts`, or `settings/auth-mode.ts`, you have broken Slack (Node) and blocky-chat/mobile. Grep to confirm: `grep -rnE "window\.|sessionStorage|localStorage|document\." src/auth src/settings` should return hits **only** in `browser-redirect.ts`.
- **Storage always via `StorageAdapter`.** Token persistence goes through the adapter (Office `roamingSettings` / `chrome.storage` / Expo `SecureStore` / Node store) — never a global. `browser-redirect.ts` uses `sessionStorage` for the transient PKCE verifier only; that is its browser-only contract, not a pattern to copy into other flows. **[consumer]** SecureStore has a ~2KB item limit and the token is ~2.5KB — a known RN concern; split or use AsyncStorage as needed.
- **`fetch` in `tokens.ts`.** Global `fetch` is called directly (no transport seam in auth yet). Plain token-exchange/refresh POSTs work in RN; the RN instability is streaming, not this. Do not add streaming here.

---

## Phase 4 — Security review

Run the security checklist in `../sdk/references/security.md` (invariant D). Auth-specific must-checks:

- **Tokens never logged, never bundled.** `refreshTokens` logs `console.error("[auth] refreshTokens failed:", res.status, text)` and `exchangeCode` throws `Token exchange failed: ${text}` — `text` is the response body, which must **not** be a token. Never add `refresh_token`, `access_token`, `code`, or `verifier` to any log line or thrown message. No token in a bundle, in a `NEXT_PUBLIC_*`/`import.meta.env` var (the bb-integration-example leak), or in the authorize URL.
- **Tokens only in secure storage via the adapter.** See Phase 3.
- **PKCE integrity.** S256, independent state nonce, redirect-URI comes from `IdentityAdapter.getRedirectUri()` / `BrowserRedirectOptions.redirectUri` (registered/allowlisted in Zitadel), single-use verifier cleared eagerly (`sessionStorage.removeItem` before exchange).
- **Refresh scope.** `refreshTokens` intentionally omits `scope` (Zitadel rejects custom scopes like `blockbrain:grants` on refresh). Do not "fix" this by re-adding scope.
- **id_token / nonce.** The flow validates OAuth `state` but does **not** currently send/validate an OpenID `nonce`, and `extractProfile` does not verify the signature. If you add `nonce` validation, thread it through both `login.ts` and `browser-redirect.ts` and add a regression test — don't half-wire it.
- **Untrusted input.** `decodeJwtPayload` / `extractProfile` / `subFromAccessToken` must keep returning `null`/empty on malformed input and never throw (opaque access tokens are expected).
- **Multi-tenant.** Re-confirm the `orgId` vs `targetOrgId` boundary from Phase 2 — this is the most damaging thing to get wrong.

If the change is materially security-sensitive (new flow, new crypto, token handling, tenant routing), run the `/security-review` skill on the diff before opening the PR.

---

## Phase 5 — Verify

Run from the repo root (Node 24, per `.nvmrc`). This mirrors `ci.yml`, the real merge gate.

```bash
npm run typecheck          # tsc --noEmit
npm run lint               # biome check . && eslint src
npm test                   # vitest run  → includes the public-API contract test
npm run build              # tsup + dts + css copy
npm run check:package      # publint + attw (esm-only) — proves ./auth & ./settings tree-shake React-free
```

**Auth test reality — read this before you claim "tests pass":**

- `npm test` runs `vitest run` with `include: ["src/**/*.test.{ts,tsx}"]`. The **only** vitest coverage of the auth core is `src/auth/login.test.ts` (telemetry emission, `stage` accuracy, identity binding, error re-throw — it exercises the happy path end-to-end with a stubbed `fetch`, so it does catch gross `login()` regressions). `tokens.ts` / `pkce.ts` / `browser-redirect.ts` / `jwt.ts` / `auth-mode.ts` have **no** vitest tests — changing them is **not** covered by `npm test` unless you add coverage. **Co-locate a `src/auth/<file>.test.ts` (vitest)** for your change so CI actually guards it.
- The CSRF regression test is **`src/auth/pkce.test.ts`** and it **runs in CI** (PDEV-7684). It covers: the verifier never appearing in the authorize URL (asserted against the raw URL string, so it catches a leak into any param or the fragment), `code_challenge_method=S256`, per-nonce verifier isolation across concurrent tabs, the CSRF guard on an unissued nonce, and the verifier being cleared before the exchange so a failed attempt cannot be replayed. Extend it rather than starting a new file.

  It got there the hard way: it previously lived at `test/auth/pkce-state-separation.test.ts` on `bun:test`, outside vitest's `src/**` include, so it **never executed** — while `references/security.md` cited it as coverage for the CWE-200 defect. Meanwhile `ms-outlook-addin` built its login on the very helpers it was meant to guard against. **Never add a test outside `src/`**; it will not run, and it will read as coverage to the next person.

**Public-export change** (added/renamed/removed anything in `src/auth/index.ts` or `src/settings/index.ts`): the contract test `src/public-api.contract.test.ts` (snapshot `src/__snapshots__/public-api.contract.test.ts.snap`) will fail. Only update it deliberately — `vitest -u` in the same PR — and treat it as an intentional breaking change: bump semver accordingly and **canary-test in a consumer (Outlook) before `latest`** (Outlook's `^0.7.3` era, ten minors behind, is the cautionary tale; it pins `^0.17.0` today). See `../sdk/references/adapters.md`.

**Cross-adapter pass** — before merge, confirm the change against each affected runtime in the matrix:

- [ ] Node / no-DOM (Slack): no `window`/`sessionStorage`/`document` reachable from `./auth` or `./settings` (grep from Phase 3 clean).
- [ ] RN (blocky-mobile): no new Web Crypto without the polyfill note; no new browser global.
- [ ] Lit (blocky-chat): change lives in framework-agnostic core, no React import pulled in (attw/publint confirm).
- [ ] Office add-ins: `IdentityAdapter` / `StorageAdapter` contract unchanged (or versioned + communicated).
- [ ] Tenant routing: `orgId` = home, `targetOrgId` = cross-tenant — unchanged.

**Known publish gap:** `publish.yml` runs only `typecheck + build` on a version tag — it does **not** re-run `test` / `lint` / `check:package`. `ci.yml` on `main` is the safety net, so your PR must be green there; never rely on the tag build to catch an auth regression.
