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
entry point: the layer map (21 entry points today), the five prime invariants, the adapter
matrix, and the per-change verification loop. Then load the task sub-skill:

- [`sdk-auth`](.claude/skills/sdk-auth/SKILL.md) — PKCE / tokens / refresh / `AuthContext` (security-critical)
- [`sdk-streaming`](.claude/skills/sdk-streaming/SKILL.md) — SSE parsers / `MessageStream` / routing / cancellation
- [`sdk-endpoint`](.claude/skills/sdk-endpoint/SKILL.md) — `./api` modules + `./react` hooks
- [`sdk-release`](.claude/skills/sdk-release/SKILL.md) — cut a release / canary + the gates

**Shared with GitHub Copilot.** Rules that both agents need live once, in
[`.github/copilot-instructions.md`](.github/copilot-instructions.md) — the invariants, the
style rules, the verification loop, and the PR-review bar. Copilot reads that file (plus the
path-scoped [`.github/instructions/*.instructions.md`](.github/instructions/)) automatically
on every completion and review; Claude should treat it as binding too. **Put a rule there if
it applies to both, and here or in `/sdk` only if it is Claude-specific** — duplicating it in
two places is how the two tools start contradicting each other.

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

> **The seam and the `login()` instrumentation both ship in `0.18.0`.** The
> `AnalyticsAdapter` seam and the `./analytics` subpath landed via PDEV-6854 (PR #19, consolidated
> for `main` in PR #22); the `auth_*` instrumentation landed via PDEV-6855 (recovered from a dead
> branch). They reach consumers with `0.18.0` — a surface pinned below that cannot import
> `./analytics` until it bumps; `file:`-linked or canary consumers can. **Run
> `npm run release:status` for what is actually published and what each surface pins** — do not
> trust a version written in prose here or anywhere else in this repo.

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
into a product flow. **`src/auth/login.ts` is the one wired call site** (PDEV-6855): it emits
`sign_in_started` / `sign_in_completed{latency_ms}` / `sign_in_failed{stage}` — `stage` a coarse
`launch|parse|exchange` label, never error detail — and binds the analytics identity on success via
`identifyUser(profile.sub)` + `setAnalyticsGroup(profile.orgId)`, so every *later* event is
attributed to that user + tenant instead of an anonymous device id. `login()`'s signature and
success/error behaviour are unchanged; the original error is always re-thrown.
Because `identify`/`group` bind **process-wide**, a multi-tenant server adapter (Slack) must omit
them and rely on per-event identity — both sink helpers then no-op.

`session_token_*` (`src/auth/refresh-singleton.ts`), `message_*` (`src/api/messages.ts`) and
`stream_*` (`src/api/stream-result.ts`) are wired too. **`api_error` via `trackApiError` is the
one group still unwired** — `throwIfNotOk` in `src/api/_send.ts` is the intended single emit
point (PDEV-7009).

> **One vocabulary (0.20.0).** `AnalyticsEventMap` is now an alias of `CoreEventMap`
> (`./telemetry`) and the old `auth_*` / camelCase names are gone —
> `auth_success{latencyMs}` → `sign_in_completed{latency_ms}`, `message_send` →
> `message_sent`, `stream_complete` → `message_completed`, `api_error.statusCode` →
> `status_code`. Property names are snake_case because they double as Prometheus
> label names. `LEGACY_EVENT_RENAMES` is the machine-readable old→new map; the
> migration table is in [`CHANGELOG.md`](CHANGELOG.md). **Prefer `CoreEventMap`** —
> the alias exists only so `0.19.0` type references keep resolving.

Two ready-made implementations ship as **opt-in leaves**, both typed structurally so the
SDK still declares no analytics dependency and the core still tree-shakes clean:
`./analytics/mixpanel` (`createMixpanelAdapter`, the product-analytics half) and
`./analytics/faro` (`createFaroAdapter`, the browser-RUM half). `setAnalyticsAdapter`
takes one adapter and the release gate wants both, so `createCompositeAdapter`
(from `./analytics`) fans one event out to several sinks with each child guarded
individually — one throwing sink cannot silence the others. ⚠️ The composite declares
`identify`/`group` when **any** child implements them, so composing a child that has
them with one that deliberately omits them re-arms the process-wide binding; for Slack,
compose only sinks that omit it. See
[`references/telemetry-release-gate.md`](.claude/skills/sdk/references/telemetry-release-gate.md).

## Verify loop (run before every commit)

```bash
nvm use                 # Node 24 (.nvmrc)
npm run lint            # biome + type-aware eslint
npm run typecheck       # tsc --noEmit
npm test                # vitest — INCLUDES the public-API contract test
npm run build           # tsup + tsc (dts)
npm run check:package   # publint + attw (esm-only)
npm run check:cleanroom # 3 phases: real install, no-React import, DOM-less typecheck
```

`check:cleanroom` is the only gate that exercises the **published artifact** from a
consumer's position — the others all read `src/` or the export map statically. It is also
the last step before `npm publish`. Phases 2 and 3 exist because 0.18.0 shipped a root
barrel that a Node surface could neither import nor typecheck, with every other gate green.

A public-API change fails `src/public-api.contract.test.ts` on purpose — that is a conscious
semver decision. If intentional, update the snapshot in the same PR (`npx vitest run -u
src/public-api.contract.test.ts`) and choose the version bump per
[`references/release-and-versioning.md`](.claude/skills/sdk/references/release-and-versioning.md).

## Governance

- **Commits**: Conventional Commit scoped by a Jira ticket — `feat(PDEV-123): …` (enforced by lefthook `commit-msg`).
- **Branches**: `type/TICKET-123/description` — e.g. `feat/PDEV-123/react-query-layer` (enforced by `pre-push`).
- ESM-only; published to GitHub Packages (private, `@theblockbrain` scope). `dist/` is git-ignored
  — `file:`-linked consumers must `npm run build` here once after a fresh clone/pull.
- Baseline code style follows the org **Code Cleanup & Refactoring** `SKILL.md`, but only the
  parts that apply here. That document was written for a **React application**; this is a
  framework-agnostic library, so take from it: no `any` / no `Function` / no `var`, early
  returns over nesting, no nested ternaries, typed error handling with no empty catches,
  hoisting static values and pure helpers, magic numbers as named constants, modern idioms,
  and the mandatory build in the verification checklist. **Ignore** its Tailwind v4 section
  (this package ships one CSS file and consumes no Tailwind), its React component-ordering and
  `useState`-generic rules (of 21 entry points, only `./react` and `./ui*` touch React), and its lodash import
  rules (`marked` is the only runtime dependency). Where the two disagree, the repo-specific
  rules in [`.github/copilot-instructions.md`](.github/copilot-instructions.md) win — a
  library's public `.d.ts` has constraints an app's internals do not.
