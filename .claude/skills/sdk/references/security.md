---
name: sdk-security
description: >-
  Use when touching anything security-sensitive in @theblockbrain/bb-client-sdk
  — tokens, OAuth/PKCE, refresh, multi-tenant orgId/targetOrgId scoping, markdown
  or LLM-output rendering, transport/CSP, or dependencies/publish — from EITHER
  the SDK core OR a consuming surface (Outlook/Word/PPT/Excel add-ins, SharePoint,
  Slack, mobile, Lit web components, blocky-frontend). Read it before adding a
  network call, storing a token, logging an error, or wiring a new adapter.
---

# SECURITY — concerns per layer, and the tools that enforce them

> **Inherits from**: `/sdk` — see that skill for the adapter matrix, the cross-cutting
> invariants, and the verification loop. This doc is the security deep-dive for
> invariant **D (security in every layer)** and part of invariant **E (telemetry
> without PII)**. Do not restate the adapter matrix here — see `./adapters.md`.
>
> Baseline code-style rules (import order, no `any`, early returns, **error handling**,
> the **verification checklist**) live in the org standard at
> `/Users/chihebhmida/Documents/Glassbox/SKILL.md` — follow it; this doc only adds the
> security-specific rules on top.

**Dual audience.** Every rule below binds BOTH the SDK maintainer who writes core code AND
the adapter developer who consumes it. The SDK gives you safe primitives; a surface that
logs a token, reuses `ctx.orgId` for a cross-tenant call, or `innerHTML`s raw markdown
re-introduces the exact hole the SDK closed. A change is a defect if it breaks the invariant
on *any* of the 11 surfaces.

The SDK ships as an **ESM-only**, minimal-dependency (`marked` is the sole runtime dep)
package to a **restricted** GitHub Packages registry. Small surface area is itself a security
control — keep it that way.

---

## Layer 1 — Tokens & secrets

The bearer token (`AuthContext.token`) is the crown jewel: an OAuth `access_token` (~2.5KB JWT)
or an API key. Treat it as radioactive.

| Rule | Where it lives / how it's enforced |
|---|---|
| **Never log a token.** No `console.log(ctx)`, no `console.log(headers)`. `Authorization: Bearer …` is built inside `authHeaders()` / `bbApiAuthHeaders()` and must not escape those functions. | `src/api/headers.ts`, `src/api/_auth-headers.ts` |
| **Scrub `BBApiError.responseBody` before logging.** `throwIfNotOk` attaches the raw `res.json()` body to the error; an auth/refresh endpoint's error body can echo tokens or codes. Log `err.statusCode` + `err.endpoint`, never the whole error object, and never the whole `responseBody` from an auth route. | `BBApiError` in `src/api/errors.ts`; thrown by `throwIfNotOk` in `src/api/_auth-headers.ts` |
| **Tokens only in secure storage, only via the adapter.** Never a module global, never `localStorage` in the core. Persist through `StorageAdapter.{get,set,remove}` so the storage is whatever the surface deems secure. | `StorageAdapter` in `src/adapters/storage.ts` — see `./adapters.md` |
| **PKCE `code_verifier` never travels in the URL.** It is stored in `sessionStorage` keyed by the state nonce (`bb_pkce_verifier:<nonce>`) and cleared eagerly after exchange. The `encodePKCEState`/`decodePKCEState` exports that stuffed the verifier into `state` are **`@deprecated` (CWE-200)** — never call them in new code. | `src/auth/pkce.ts`, `src/auth/browser-redirect.ts` |
| **NEVER put a token in the bundle or a `NEXT_PUBLIC_` var.** `NEXT_PUBLIC_*` is inlined into client JS and shipped to the browser. **Cautionary tale:** `bb-integration-example` shipped a live token-exposure defect exactly this way — its Next.js BFF must hold the bearer server-side (raw `httpx`), never expose it to the client. | consuming-surface rule |
| **Least-scope PAT.** Consumers install with a classic PAT scoped to **`read:packages` only** (plus repo grant), stored in machine-level `~/.npmrc` — never the committed project `.npmrc`. Publish uses the workflow `GITHUB_TOKEN`, not a personal token. | README install block; `.github/workflows/publish.yml` |
| **No committed secrets.** `.gitignore` covers `node_modules/` + `dist`; secrets belong in CI secrets or untracked `~/.npmrc`. A secret-scan (gitleaks) is the intended tripwire — **verify it is wired in CI before relying on it** (not present in `.github/workflows/` today; treat as a target, and scan manually on any auth PR). | `.gitignore`; gitleaks = target |

**Adapter obligation:** your `StorageAdapter` must write to genuinely secure storage for your
runtime — Office `roamingSettings`, `chrome.storage`, Expo `SecureStore` (mind the ~2KB item
limit vs the ~2.5KB token — split or use `AsyncStorage` deliberately), or a server-side store
for Slack. Never `window.localStorage` for a token on a shared/embedded surface.

---

## Layer 2 — Auth / PKCE

OAuth is Zitadel Authorization-Code + **PKCE S256**. The SDK core is DOM-free except where it
must reach Web Crypto (`crypto.getRandomValues`, `crypto.subtle.digest`) — that's a documented
capability requirement, not a browser assumption (see invariant B).

| Concern | Implementation (verified) | Notes / gaps |
|---|---|---|
| **S256 only** | `generateChallenge()` = base64url(SHA-256(verifier)); the authorize URL sets `code_challenge_method=S256`. Verifier = 32 random bytes → 43-char base64url (RFC 7636), **not** `randomUUID()`. | `src/auth/pkce.ts`; `beginBrowserLogin` in `src/auth/browser-redirect.ts` |
| **State / CSRF** | `generateStateNonce()` produces an independent 32-byte nonce (NOT derived from the verifier). `completeBrowserLogin` throws on missing state ("possible CSRF") and on a nonce with no stored verifier. | Regression test `test/auth/pkce-state-separation.test.ts` asserts the verifier never appears in the authorize URL. **CAVEAT: that test still imports `bun:test` and is EXCLUDED by `vitest.config.ts` (`include: src/**`), so it does NOT run in CI today** — migrating it to vitest is roadmap **WS1**. Until then, re-verify state separation manually on any auth change. |
| **Redirect-URI allowlist** | `redirectUri` is caller-supplied and must be **pre-registered in the Zitadel app**; Zitadel rejects unregistered URIs. The SDK does not maintain its own allowlist. | `BrowserRedirectOptions.redirectUri`; adapter `IdentityAdapter.getRedirectUri` must return a registered value. |
| **id_token / nonce validation** | The SDK does **client-side decode only, NO signature verification** — the server validates the token (`decodeJwtPayload` comment). An OIDC `nonce` is **not currently sent or validated** by `browser-redirect.ts`. | Treat id_token signature + nonce validation as a **server-side responsibility / SDK gap** — do not claim the SDK verifies them. If you need client-side nonce binding, it must be added (thread a nonce through authorize + validate in `completeBrowserLogin`). |
| **Single-flight refresh** | `createRefreshGuard()` shares one in-flight promise across racing callers — prevents refresh storms and duplicate refresh-token spend. | `src/auth/refresh-singleton.ts`; expiry check `isTokenExpired` in `src/auth/tokens.ts` |
| **Audience pinning** | In OAuth mode `getAuthContext` **hardcodes `baseUrl` to `OAUTH_BACKEND_URL`** (`https://blocky.theblockbrain.ai`) and **ignores `settings.bbUrl`** — tokens are minted for the `auth.theblockbrain.ai` audience and are only valid there. Sending them elsewhere leaks a valid bearer to an unintended host. | `src/settings/auth-mode.ts`, `src/config.ts`. Only `api-key` mode honors `settings.bbUrl`. |

**Adapter obligation:** implement `IdentityAdapter.launchOAuthFlow` with the platform's real
consent UI (Office `displayDialogAsync`, `chrome.identity`, device-code for Lit/mobile). Do not
short-circuit PKCE. Mobile needs a **Web Crypto polyfill** (RN lacks `crypto.subtle`); device-code
flow is **not yet in the SDK** — that's a known gap, not something to hand-roll insecurely.

---

## Layer 3 — Multi-tenant isolation (zero cross-tenant leakage)

This is the single highest-severity invariant. Two org identifiers, two completely different jobs:

| Identifier | Meaning | Wire location |
|---|---|---|
| `AuthContext.orgId` | The caller's **HOME** org — the org the JWT was issued for (where the user has roles). | Sent as the **`x-zitadel-org-id` header** (OAuth mode only; omitted for api-key — the integrations host 500s on it). |
| `targetOrgId` (per-call arg) | The tenant an **admin operation acts on**. | Becomes the **`?orgId=` query param**. Defaults to `ctx.orgId` (self-tenant) when omitted. |

**The rule:** to operate cross-tenant, pass a separate `targetOrgId` to the individual API
function — **NEVER** mutate `AuthContext.orgId` to the target tenant. Swapping the home org in
the context changes the *authentication* identity and defeats the isolation boundary.

Verified call sites that take `targetOrgId` → `?orgId=`: `src/api/agents.ts`,
`src/api/capabilities.ts`, `src/api/tenant-config.ts`. Admin tenant listing
(`listTenants`/`getTenantById`) returns the `zitadelOrgId` you then pass as `targetOrgId`.

**Slack is zero-tolerance.** `bb-slack-integrations` is server-side and multi-workspace: its
Slack-team → BlockBrain-tenant mapping must resolve to the correct `targetOrgId` for **every**
request, with **0** cross-tenant events. A mis-mapped token here leaks one customer's data to
another workspace. Test the mapping table, don't trust it.

**Any new tenant-scoped API function MUST** expose `targetOrgId` as its own parameter (mirroring
`agents.ts`) and route it to `?orgId=` — never reach for `ctx.orgId` as the operation target.

---

## Layer 4 — Untrusted input (LLM output, tool output, user text)

Everything coming back from a model, a tool, or a user is hostile until proven otherwise.

| Concern | Implementation (verified) |
|---|---|
| **`extractJson` NEVER throws.** LLM JSON is malformed constantly; the parser returns `T \| null` and best-effort-repairs unescaped quotes. Callers **must handle `null`** — never assume a parse. | `extractJson` / `repairUnescapedQuotes` in `src/utils/extract-json.ts` |
| **Markdown rendering is XSS-safe by construction.** `renderMarkdown` builds a `DocumentFragment` with `createElement`/`createTextNode` — it **never `innerHTML`s raw input**. Raw HTML blocks and images are dropped. Links are validated with `new URL()` against a protocol allowlist (`https:`/`http:`/`mailto:`); `javascript:` and other schemes render as plain text. `markdownToHtml`'s single `innerHTML` read serializes a DOM the SDK built itself — safe. | `src/ui/markdown.ts` (`./ui` — React/DOM only) |
| **Validate tool / action output** before acting on it — same posture as `extractJson`: parse defensively, handle the failure branch, never `eval`. | `src/actions/runner.ts`, `src/prompt/parse-response.ts` |

**Adapter obligation:** if you render assistant output yourself (custom UI, a non-React surface
like Lit/blocky-chat, or Slack Block Kit), you must apply the same discipline — go through
`renderMarkdown`/`markdownToHtml`, or replicate its allowlist + no-`innerHTML`-of-raw-input rule.
Never `dangerouslySetInnerHTML` / `.innerHTML =` on model output.

---

## Layer 5 — Transport & CSP

| Concern | Rule |
|---|---|
| **HTTPS only** | All config endpoints are `https://` (`AUTH_AUTHORITY`, `OAUTH_BACKEND_URL`, `TOKEN_ENDPOINT`, `AGENTIC_BASE_URL` in `src/config.ts`). Never introduce an `http://` production endpoint. |
| **No `eval` / no `new Function` / no inline injection** | Required for the **strict-CSP** surfaces — SharePoint (SPFx) and Office add-in webviews forbid `eval` and inline script. The markdown renderer already avoids `eval`/`innerHTML`-of-input; keep the whole core CSP-clean so `sharepoint-extension` and `Webcomponent-Webpart` can load it. |
| **No runtime assumptions** | Do not hard-depend on `window`/`document`/`fetch`/`EventSource` in the core (invariant B) — Slack is Node (no DOM), RN `fetch`/`ReadableStream` is unstable (the transport-seam blocker). Reach platform I/O through an adapter or a capability check. |

---

## Layer 6 — Supply chain

| Control | State (verified) |
|---|---|
| **Minimal runtime deps** | Exactly one: `marked ^14`. `react` + `@tanstack/react-query` are **optional peers** (only `./react` + `./ui` touch them). Adding a runtime dep is a security decision — justify it. |
| **`./api` + `./auth` tree-shake with ZERO React** | Enforced by the export map + `attw`/`publint`. Keeps the framework-agnostic core clean for Slack (Node) and blocky-chat (Lit). See invariant A. |
| **Restricted registry** | `publishConfig` → `https://npm.pkg.github.com`, `access: restricted`. Not public npm. |
| **ESM-only** | `"type": "module"`; `check:package` runs `attw --profile esm-only`. |
| **`npm audit` / Dependabot** | Run `npm audit` on dependency PRs; keep Dependabot on. |
| **Provenance** | `publish.yml` runs plain `npm publish` (no `--provenance`) today — treat provenance as a **target**, not a current guarantee. |

---

## Tools — what each one actually checks

| Tool | Command / trigger | What it guards |
|---|---|---|
| **Biome** | `lint:biome` (`biome check .`); pre-commit on staged files | Format + base lint; fast first gate |
| **ESLint (type-aware)** | `lint:types` (`eslint src`) | typescript-eslint + react-hooks + `@tanstack/eslint-plugin-query`; catches unsafe patterns inference can't |
| **publint** | `check:package` | Package/export-map correctness (ESM resolution) |
| **attw** (`@arethetypeswrong/cli`) | `check:package` (`--profile esm-only`) | Types resolve on every entry point → **no React leaks into `./api`/`./auth`** |
| **Public-API contract test** | `src/public-api.contract.test.ts` (+ snapshot) | Anti-breakage tripwire — an undeclared change across the 12 entry points fails the test |
| **PKCE state-separation test** | `test/auth/pkce-state-separation.test.ts` | Verifier never in authorize URL (CWE-200). **NOTE: `bun:test`, excluded from CI (WS1)** — run manually |
| **npm audit / Dependabot** | dependency PRs | Known-vuln deps |
| **gitleaks (secret-scan)** | target — **not in CI yet** | Committed tokens/keys |
| **Sentry** | per-surface wiring | Crash/error telemetry (health half of invariant E) |
| **Grafana Faro** | per-surface (browser) | RUM: crash-free % + error rate |
| **Mixpanel** | per-surface | Product analytics — **identity = Zitadel `sub`, org as group, NO PII** (no email/name in events) |
| **CodeQL / SAST** | optional | Deeper static analysis — enable per repo risk |

**Telemetry seam is shipped (WS9).** The `AnalyticsAdapter` (peer of `StorageAdapter`/
`IdentityAdapter`) is exported as types from `./adapters`, with the runtime sink at `./analytics`
(`setAnalyticsAdapter`, `trackEvent`, `trackApiError`, …). Its taxonomy is the typed
**`AnalyticsEventMap`** (`AnalyticsEventName = keyof AnalyticsEventMap`) — `auth_started`,
`auth_success`, `auth_failed`, `token_refresh`, `message_send`, `stream_start`,
`stream_first_token`, `stream_complete`, `stream_dropped`, `stream_reconnect`, `api_error` —
defined in [`./telemetry-release-gate.md`](./telemetry-release-gate.md) §1; use those keys
**verbatim** (there is no `auth_fail` / `first_token` / `complete` / `dropped` shorthand — the
typed map rejects anything else). Now that the seam has landed, invariant-E "Part B" is measurable
once a surface wires it — and the **release gate still applies**: nothing ships to prod without
BOTH product analytics (Mixpanel) AND health telemetry (Sentry + Faro), each surface still
registering its own adapter. When emitting `api_error`, send only `statusCode` + `endpoint` —
**never** `responseBody` (Layer 1).

**CI reality check:** `ci.yml` (lint:biome → lint:types → typecheck → test → build → check:package)
is the real merge gate. `publish.yml` runs **only typecheck + build** on a `vX.Y.Z` tag — it does
**NOT** re-run test / lint / check:package (KNOWN GAP; target SLO E2 = "CI + publish both gated on
tests"). A release therefore does not re-verify the security tests; `ci.yml` on `main` is the only
safety net. Factor this in when cutting a release from a security-sensitive change.

---

## Security review checklist — any auth / token / tenant change

Run this before requesting review on a change that touches auth, tokens, refresh, headers, or
tenant scoping. (Complements — does not replace — the org **Verification Checklist** in
`/Users/chihebhmida/Documents/Glassbox/SKILL.md`.)

- [ ] **No token in logs.** No `console.*` of `ctx`, headers, tokens, or a full `BBApiError`. Auth-route `responseBody` is scrubbed before any logging.
- [ ] **No token in the bundle.** No `NEXT_PUBLIC_`/build-time inlining of a secret; tokens only via `StorageAdapter` (recall the `bb-integration-example` defect).
- [ ] **PKCE intact.** S256 only; `state` is an independent nonce; verifier stays in storage keyed by nonce and is never added to the authorize URL. Deprecated `encode/decodePKCEState` not reintroduced. State-separation manually re-verified (test is CI-excluded).
- [ ] **Refresh single-flight.** New refresh paths go through `createRefreshGuard` — no parallel refresh.
- [ ] **Audience pinned.** OAuth calls still resolve `baseUrl` from `OAUTH_BACKEND_URL`; `settings.bbUrl` is not honored in OAuth mode.
- [ ] **Tenant scoping.** Cross-tenant ops pass `targetOrgId` → `?orgId=`; `AuthContext.orgId` is untouched (home org / `x-zitadel-org-id`). New tenant-scoped functions expose their own `targetOrgId` param. Slack mapping resolves the correct tenant with 0 cross-tenant.
- [ ] **Untrusted input.** New model/tool output paths handle `extractJson` returning `null`; any new rendering goes through `renderMarkdown` (no `innerHTML`/`dangerouslySetInnerHTML` on model output).
- [ ] **Transport/CSP.** HTTPS only; no `eval`/`new Function`/inline script (SPFx + Office webviews); no new hard dependency on `window`/`fetch`/`EventSource` in the core.
- [ ] **Supply chain.** No new runtime dep without justification; `./api`/`./auth` still React-free (`check:package` green); `npm audit` clean.
- [ ] **Public-API contract test passes** — or the snapshot change is intentional, declared, and canary-tested in a consumer (Outlook) **before** promoting to `latest` (invariant C; the stale `^0.7.3` pin is the cautionary tale).
- [ ] **Telemetry.** If this adds a security-relevant event, it emits a valid `AnalyticsEvent` from the union (e.g. `auth_success`/`auth_failed`, `token_refresh`, `api_error{statusCode,endpoint}`) with **no PII and no token/responseBody** (identity = `sub`, org = group).

**Adapter reviewers:** the same list applies to you — your `StorageAdapter` secure-storage choice,
your `IdentityAdapter` OAuth flow, your logging, and your tenant resolution all uphold these
invariants, or the surface is the leak.
