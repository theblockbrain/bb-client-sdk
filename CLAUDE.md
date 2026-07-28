# bb-client-sdk — agent & contributor guide

`@theblockbrain/bb-client-sdk` is the **shared, framework-agnostic** frontend SDK
("thin surface, thick SDK") consumed by **every** BlockBrain "Apps" surface — React
add-ins (Outlook / Word / PowerPoint / Excel), an SPFx extension + web part
(SharePoint / Teams), a Lit web component (blocky-chat), a Node backend (Slack), a
React-Native app (mobile), and web SPAs. **A change here fans out to all of them** —
a change that breaks any one adapter is a defect.

## Start here — load the `/sdk` skill

Before doing **any** work in this repo, load the base skill:
[`.claude/skills/sdk/SKILL.md`](.claude/skills/sdk/SKILL.md). It is the authoritative
entry point: the layer map (13 entry points today), the five prime invariants, the adapter
matrix, and the per-change verification loop. Then load the task sub-skill:

- [`sdk-auth`](.claude/skills/sdk-auth/SKILL.md) — PKCE / tokens / refresh / `AuthContext` (security-critical)
- [`sdk-streaming`](.claude/skills/sdk-streaming/SKILL.md) — SSE parsers / `MessageStream` / routing / cancellation
- [`sdk-endpoint`](.claude/skills/sdk-endpoint/SKILL.md) — `./api` modules + `./react` hooks
- [`sdk-release`](.claude/skills/sdk-release/SKILL.md) — cut a release / canary + the gates

Reference docs (under `sdk/references/`):
[adapter matrix](.claude/skills/sdk/references/adapters.md) ·
[cross-adapter safety](.claude/skills/sdk/references/cross-adapter-safety.md) ·
[security](.claude/skills/sdk/references/security.md) ·
[telemetry release gate](.claude/skills/sdk/references/telemetry-release-gate.md) ·
[release & versioning](.claude/skills/sdk/references/release-and-versioning.md).

## The five invariants (full detail in `/sdk`)

1. **Framework-agnostic core** — only `./react` + `./ui` may import React; `./api` / `./auth`
   tree-shake with zero React. Non-React consumers import subpaths, never the root barrel.
2. **No runtime assumptions** — no bare `window` / `document` / `localStorage` / `fetch` /
   Web-Crypto in the core; storage is always via `StorageAdapter`; `fetch`/`ReadableStream`
   is unreliable in React Native.
3. **Verify all adapters** — every change is checked against the adapter matrix; public-API
   changes pass the contract test **and** are canary-tested in Outlook before `latest`.
4. **Security in every layer** — tokens never logged / bundled; PKCE S256 + CSRF; `orgId` vs
   `targetOrgId` discipline; **0 cross-tenant leakage**; `extractJson` never throws; minimal deps.
5. **Instrument every surface (hard release gate)** — nothing ships to production without both
   product analytics (Mixpanel) **and** health telemetry (Sentry + Grafana Faro). Emit via the
   `AnalyticsAdapter` seam (the `./analytics` subpath; see the section below).

## Telemetry seam (`./analytics`)

> **The seam is on `main`, not yet published; the instrumentation is on neither.** The
> `AnalyticsAdapter` seam and the `./analytics` subpath landed via PDEV-6854 (PR #19, consolidated
> for `main` in PR #22). The last published tag is `v0.17.0`, which predates them: a consumer on
> npm/GitHub Packages cannot import `./analytics` until the next release; `file:`-linked or canary
> consumers can. The `login()` instrumentation (PDEV-6855) is a separate matter — see below.

The `AnalyticsAdapter` seam is a peer of `StorageAdapter` / `IdentityAdapter`. Each surface
implements it once and registers it at startup; the SDK emits a typed, PII-free event taxonomy
through it (auth, streaming, `api_error`, …), which the surface forwards to Mixpanel + Sentry.

```ts
import { setAnalyticsAdapter } from "@theblockbrain/bb-client-sdk/analytics";
import type { AnalyticsAdapter } from "@theblockbrain/bb-client-sdk/adapters";

const analytics: AnalyticsAdapter = {
  track: (event, props, identity) => mixpanel.track(event, { ...props, ...identity }),
  captureError: (error, context) => Sentry.captureException(error, { extra: context }),
  identify: (distinctId) => mixpanel.identify(distinctId),      // Zitadel `sub` — never PII
  group: (orgId) => mixpanel.set_group("org", orgId),
};
setAnalyticsAdapter(analytics);
```

The sink is safe by construction: it **no-ops when no adapter is registered and never throws**
into a product flow. **No SDK call site emits through it yet** — `grep -rn "trackEvent" src/`
returns only the sink itself. The `login()` instrumentation (PDEV-6855) exists on
`feat/PDEV-6855/instrument-auth-telemetry` but **never reached `main`**: PR #20 was merged into
`feat/PDEV-6854/telemetry-adapter` at 09:18 on 2026-07-20, 17 minutes *after* that base branch had
already merged to `main` in PR #19 — so the child landed on a dead branch. Re-merging it (plus its
`src/auth/login.test.ts`, also absent from `main`) is outstanding work, not a done ticket.

A ready-made Mixpanel implementation ships as an **opt-in leaf** at `./analytics/mixpanel`
(`createMixpanelAdapter`) — typed structurally against `mixpanel-browser`, so the SDK still has
no analytics dependency and the core still tree-shakes clean. See
[`references/telemetry-release-gate.md`](.claude/skills/sdk/references/telemetry-release-gate.md).

## Verify loop (run before every commit)

```bash
nvm use                 # Node 24 (.nvmrc)
npm run lint            # biome + type-aware eslint
npm run typecheck       # tsc --noEmit
npm test                # vitest — INCLUDES the public-API contract test
npm run build           # tsup + tsc (dts)
npm run check:package   # publint + attw (esm-only)
```

A public-API change fails `src/public-api.contract.test.ts` on purpose — that is a conscious
semver decision. If intentional, update the snapshot in the same PR (`npx vitest run -u
src/public-api.contract.test.ts`) and choose the version bump per
[`references/release-and-versioning.md`](.claude/skills/sdk/references/release-and-versioning.md).

## Governance

- **Commits**: Conventional Commit scoped by a Jira ticket — `feat(PDEV-123): …` (enforced by lefthook `commit-msg`).
- **Branches**: `type/TICKET-123/description` — e.g. `feat/PDEV-123/react-query-layer` (enforced by `pre-push`).
- ESM-only; published to GitHub Packages (private, `@theblockbrain` scope). `dist/` is git-ignored
  — `file:`-linked consumers must `npm run build` here once after a fresh clone/pull.
- Baseline code style follows the org **Code Cleanup & Refactoring** `SKILL.md` (import order, no
  `any`, early returns, typed error handling, mandatory build in the verification checklist).
