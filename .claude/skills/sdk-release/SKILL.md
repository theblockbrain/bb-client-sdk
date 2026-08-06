---
name: sdk-release
description: "Use when cutting an SDK release or canary, or preparing a change for consumers — runs the pre-release gate, canary validation, versioning decision, and the telemetry release-gate check."
allowed-tools: Read, Bash, Grep, Glob, Edit
---

# sdk-release — cut a `@theblockbrain/bb-client-sdk` release (or canary) safely

> **Inherits from**: `/sdk` — see that skill for the adapter matrix, the cross-cutting invariants (A–E), and the verification loop. This sub-skill does not restate them; it links.
>
> - Versioning mechanics, the SemVer-for-fan-out table, the contract tripwire, consumer pin policy, commit/branch governance: [`../sdk/references/release-and-versioning.md`](../sdk/references/release-and-versioning.md)
> - The Definition-of-Done telemetry gate per surface: [`../sdk/references/telemetry-release-gate.md`](../sdk/references/telemetry-release-gate.md)
> - Adapter matrix (which runtimes/auth/storage/CSP a change touches): [`../sdk/references/adapters.md`](../sdk/references/adapters.md)
> - Org code-style baseline (import order, no `any`, verification checklist): **Code Cleanup & Refactoring** standard

**Dual audience.** Maintainers cut and tag releases (Phases 1–5). Adapter (consumer) developers own the canary consumer build (Phase 3), the telemetry gate on their surface (Phase 4), and the upgrade nudge (Phase 6). A version is a contract with **every** surface in [`../sdk/references/adapters.md`](../sdk/references/adapters.md) at once — a change that breaks any one is a defect (invariant C).

**Toolchain is Node 24.** `.nvmrc` = `24.18.0`, `engines.node` = `>=24`, and every workflow reads `node-version-file: ".nvmrc"`. Run `nvm use` first; releasing on an older Node is unsupported.

Follow these phases **exactly, in order**. Do not skip Phase 4.

---

## Phase 1 — Pre-release gate (reproduce the full CI locally)

**Start here — `npm run release:status`.** It prints what `package.json` declares, the newest git tag, what the registry actually serves, and every consumer's pin, then flags the divergences. A tag whose publish failed is invisible to `git` and looks identical to a successful one from the terminal; this is the only cheap way to see it. Do not open the release with a version you read in a document.

Then the gate. Since PDEV-7001, `publish.yml` re-runs it on the tag, so a bad commit no longer publishes silently (see Phase 5). Reproduce it locally anyway on the exact SHA you intend to release — a failure there costs a minute, a failure on the tag costs a burnt version number. Run the whole gate, in `ci.yml` order, from the repo root on Node 24:

```bash
nvm use                 # reads .nvmrc (24.18.0)
npm run release:status  # where is this package, actually?
npm ci                  # clean install — match CI, not your stale node_modules
npm run lint:biome      # biome check .
npm run lint:types      # eslint src (type-aware: ts-eslint + react-hooks + @tanstack/query)
npm run typecheck       # tsc --noEmit over all of src
npm test                # vitest run — INCLUDES the public-API contract test
npm run test:coverage   # vitest run --coverage (coverage-v8) — confirm no regression
npm run build           # tsup + tsc -p tsconfig.build.json (dts) + copy theme-base.css
npm run check:package   # publint + attw --pack . --profile esm-only
```

All must be green. Then, specifically:

- [ ] **Public-API contract test passed.** `src/public-api.contract.test.ts` snapshots the exported values **and** types of all JS entry points (14 today) (snapshot: `src/__snapshots__/public-api.contract.test.ts.snap`). To inspect just it:
  ```bash
  npx vitest run src/public-api.contract.test.ts
  ```
  A failure means the public surface changed. That is a **conscious semver decision**, not a test to silence — carry it into Phase 2. If the change is intentional, the snapshot must already be updated **in the same PR** (`npx vitest run -u src/public-api.contract.test.ts`) and reviewed. A snapshot diff with no version bump and no migration note is a release blocker.
- [ ] **`check:package` clean** — confirms the export map still tree-shakes and that `./api` + `./auth` carry **zero React** in their graph (invariant A). Slack (Node) and blocky-chat (Lit) consume the core with no React present.
- [ ] **Green CI on the release SHA.** Local green is necessary but not sufficient — confirm `ci.yml` itself concluded `success` on the commit you will tag (it must be a merged `main` commit):
  ```bash
  gh api "repos/theblockbrain/bb-client-sdk/commits/$(git rev-parse HEAD)/check-runs" \
    --jq '.check_runs[] | "\(.name): \(.status)/\(.conclusion)"'
  ```
  Every check must read `completed/success`. Do not tag a SHA whose CI is pending, failed, or absent.

---

## Phase 2 — Versioning decision

Did the public-API snapshot change in Phase 1, or did the runtime behavior of a stable export change? Decide the bump from the full table in [`../sdk/references/release-and-versioning.md`](../sdk/references/release-and-versioning.md) §1 — the short version:

| The change | Bump | Trigger |
| --- | --- | --- |
| Remove/rename an exported symbol or type; change a signature; change behavior of a stable export; move a symbol between entry points; change a wire shape (`x-zitadel-org-id`, `?orgId=`, Blocky `new_token`→`message_ready`); drop a Node version; change ESM shape | **MAJOR** (see `0.x` rule) | Contract break — fans out silently under `^` ranges |
| Add a new export / entry point / optional param / optional returned field; widen an input type; add an optional adapter method | **MINOR** | Purely additive |
| Bug fix with no surface/behavior change; docs; internal refactor | **PATCH** | Contract unchanged |

> **At `0.x`, a minor IS this package's "major".** Consumers pin `^0.MINOR.PATCH`, which npm locks to the minor (`^0.M.P` resolves `<0.M+1.0`). So a **breaking** change must land as a **minor** bump **with a documented migration note** — never a patch. Do not rely on `0.x` semver leniency; that is what silently fans out to surfaces. (`npm run release:status` prints the current version — this rule does not depend on it.)

If breaking: write the **migration note** now (README/CHANGELOG: what changed, before→after call site, which surfaces in [`../sdk/references/adapters.md`](../sdk/references/adapters.md) must act) and mark the landing commit with the breaking-change `!` (`feat(PDEV-XXXX)!: …`) so the semver decision is auditable. Do not bump `package.json` yet — the bump commit lands in Phase 5, after the canary proves the change in a real consumer.

---

## Phase 3 — Canary FIRST (validate in a consumer before `latest`)

**Every contract-affecting change — and anything touching the transport/auth/streaming seams — gets a canary before a real tag.** `canary.yml` publishes a throwaway build under the `canary` dist-tag; it **never** touches `latest`, so stable consumers are unaffected.

1. **Trigger the canary** on the PR (uses the built-in `GITHUB_TOKEN`, no admin needed):
   ```bash
   gh pr edit <PR-NUMBER> --repo theblockbrain/bb-client-sdk --add-label "release:canary"
   # …or run it manually from any ref:
   gh workflow run "Canary release" --repo theblockbrain/bb-client-sdk --ref <branch>
   ```
   The workflow gates on `typecheck` + `build`, publishes `0.0.0-canary.<short-sha>`, and comments the exact install line on the PR.

2. **Install and build in Outlook — the reference adopter.** In the `ms-outlook-addin` repo:
   ```bash
   npm install @theblockbrain/bb-client-sdk@0.0.0-canary.<short-sha>   # exact build
   #  …or the moving tag that always points at the newest canary:
   npm install @theblockbrain/bb-client-sdk@canary
   npm run build   # then smoke-test the affected flow
   ```
   Smoke-test the affected flow against the adapter matrix: does PKCE-via-Office-dialog auth, `roamingSettings` storage, and streaming still work in the Office.js webview? Outlook is the canary consumer because it exercises a real, constrained runtime.

> **The `notify-consumers` job is DORMANT** — it only fires when `vars.CONSUMER_DISPATCH_ENABLED == 'true'` with an org GitHub App token (`secrets.CONSUMER_DISPATCH_TOKEN`); the default `GITHUB_TOKEN` cannot trigger cross-repo workflows (PDEV-6806). Until that App is wired, **canary consumer testing is manual** — you install and build in the consumer yourself. Do not assume a consumer got tested automatically.

Only after a consumer builds green do you proceed. If Outlook cannot build the canary because its pin assumes an old surface (see Phase 6, the `^0.7.3` era), that is itself a signal — the surface has drifted too far to be a reliable pre-`latest` check.

---

## Phase 4 — THE TELEMETRY RELEASE GATE (Definition-of-Done, not optional)

Invariant E, documented and **non-negotiable**: nothing ships to production on a consuming surface without **both** (1) product analytics (Mixpanel: activation/funnel/retention, Zitadel `sub` as distinct id, org as group, **no PII**) **and** (2) health telemetry (crash/error: Sentry + Grafana Faro RUM). This gate is checked **per surface being promoted**, not on the SDK package itself.

Walk the full checklist in [`../sdk/references/telemetry-release-gate.md`](../sdk/references/telemetry-release-gate.md). Do not promote a surface unless all of:

- [ ] **`AnalyticsAdapter` wired** on the surface (peer of `StorageAdapter`/`IdentityAdapter`). The seam (**WS9** — PDEV-6854/6855) ships in **`0.18.0`**; a surface still pinned to `^0.17.0` needs a canary or `file:` link until it bumps. Register a concrete adapter at startup via `setAnalyticsAdapter` (from `@theblockbrain/bb-client-sdk/analytics`) implementing the `AnalyticsAdapter` type (from `@theblockbrain/bb-client-sdk/adapters`), or use `createMixpanelAdapter` from `@theblockbrain/bb-client-sdk/analytics/mixpanel`. Registering an adapter today gets the surface the SDK's `auth_started`/`auth_success`/`auth_failed` funnel for free (`src/auth/login.ts`, PDEV-6855 — the only wired call site) plus its own events; `token_refresh`, `message_send`, `stream_*` and `api_error` are still unwired in the SDK.
- [ ] **Minimum event set emitting**, mapped to the standard taxonomy: `auth_success` / `auth_failed`, `message_send`, `stream_start` / `stream_first_token` / `stream_complete` / `stream_dropped`, and `api_error{ statusCode, endpoint }`. The last maps directly off `BBApiError` (`src/api/errors.ts`), which carries `statusCode` and `endpoint` on every non-2xx — that is exactly why the core throws it. **Never** forward `BBApiError.responseBody` raw to Sentry/analytics; scrub it (it may echo secrets) and never log tokens (invariant D).
- [ ] **Sentry + Grafana Faro live** on the surface (crash-free and error-rate reporting), verified receiving events — not merely configured.

If a surface cannot satisfy this, it does not get promoted, regardless of feature-readiness. (With the WS9 seam landed, the telemetry half of the SLO becomes measurable the moment a surface wires it.)

---

## Phase 5 — Publish (tag `vX.Y.Z`) — and mind the gate gap

Release from a **merged, CI-green `main` commit** (the one you verified in Phase 1). Because branch protection blocks direct pushes to `main`, the version bump itself goes through a PR:

1. **Bump on a ticket-scoped branch** (governance: [`../sdk/references/release-and-versioning.md`](../sdk/references/release-and-versioning.md) §5):
   ```bash
   git switch -c chore/PDEV-XXXX/release-v0-18-0
   npm version minor --no-git-tag-version      # patch | minor  (0.x-minor for a BREAKING change)
   git commit -am "chore(PDEV-XXXX): release v0.18.0"
   git push -u origin chore/PDEV-XXXX/release-v0-18-0
   ```
   Open the PR, let **`ci.yml` run the full gate**, and merge. Merging to `main` is where the real gate executes.

2. **Tag the merged `main` SHA and push the tag** (pushing `v*` triggers `publish.yml`):
   ```bash
   git switch main && git pull
   git tag v0.18.0
   git push origin v0.18.0
   ```

> ### ✅ CLOSED — `publish.yml` now runs the full gate (SLO E2)
> PDEV-7001 closed the hole. On a `v*` tag, `publish.yml` runs a **tag ↔ `package.json` version guard** → `lint` → `typecheck` → `test` → `build` → `check:package` → `check:cleanroom`, and only then `npm publish`. A tag on a commit whose tests never went green now fails the publish instead of shipping it, and a tag whose number disagrees with `package.json` is rejected outright.
>
> Two things this does **not** do, so keep doing them by hand: it does not prove the change works in a **consumer** (that is Phase 3's canary), and it does not check **telemetry** on the surface being promoted (Phase 4). Confirming `ci.yml` concluded `completed/success` on the merged `main` commit is still worth the ten seconds — it fails earlier and more cheaply than the tag does.

After the tag: confirm `publish.yml` succeeded and that the version resolves from the registry under the `latest` dist-tag (`npm view @theblockbrain/bb-client-sdk version`).

---

## Phase 6 — Post-release (nudge consumers off stale pins)

A published version is worthless if surfaces never adopt it. Under `^` ranges a breaking change fans out silently; a **frozen** pin trades that for ever-growing migration debt.

- **The cautionary tale.** `ms-outlook-addin` — the reference adopter — sat on **`^0.7.3`** while the SDK reached **`0.17.0`** (~10 minor eras behind). Consequences mapped straight to the invariants: it could not canary-test current changes (Phase 3 lost its signal), and every accumulated break landed in one painful upgrade instead of being absorbed incrementally. It was brought back in step in July 2026. Keeping it within one era is a standing obligation, not a solved problem — `npm run release:status` flags it when it slips.
- **The rule — SLO E3: no surface more than one minor-era behind.** After a release, open (or nudge) an upgrade PR on each consuming surface so it tracks within one minor of current. One small PR per surface per release era is cheap; a 10-era jump is not.
- **`file:`-linked consumers** (Chrome add-in, monorepo links): `dist/` is git-ignored and npm does **not** run build for symlinked `file:` deps. After any fresh clone/pull of this SDK, run `npm run build` here **once** before building the linked consumer, or its `import` of `dist/` resolves to nothing (README). Registry installs are unaffected (`prepack`/`prepublishOnly` build `dist/`).
- **Consumer pin policy** (adapter devs): pin `^0.MINOR.PATCH`, read the migration note, bump the minor deliberately. Full policy in [`../sdk/references/release-and-versioning.md`](../sdk/references/release-and-versioning.md) §4.

---

## Quick checklist (paste into the release PR)

- [ ] `npm run release:status` read — published version, tag and consumer pins are what you think
- [ ] Node 24 (`nvm use`); `npm ci` clean install
- [ ] Full local gate green: `lint:biome` + `lint:types` + `typecheck` + `test` + `test:coverage` + `build` + `check:package`
- [ ] Public-API contract test green (or snapshot updated + reviewed in this PR)
- [ ] `ci.yml` concluded `completed/success` on the exact SHA to be tagged
- [ ] Semver decision made (breaking → `0.x` **minor** + migration note); breaking commit marked `!`
- [ ] `release:canary` label added; canary built **green in a real consumer (Outlook)** and smoke-tested against the adapter matrix
- [ ] **Telemetry gate** satisfied on every surface being promoted (AnalyticsAdapter/equivalent wired, min event set emitting, Sentry + Faro live) — [`../sdk/references/telemetry-release-gate.md`](../sdk/references/telemetry-release-gate.md)
- [ ] Version bumped on a ticket-scoped branch; PR merged so full CI ran on `main`
- [ ] Tag `vX.Y.Z` pushed on the merged `main` commit; `publish.yml` succeeded; version resolves as `latest`
- [ ] `publish.yml`'s own gate green on the tag (it re-runs lint/test/`check:package`/`check:cleanroom` since PDEV-7001 — SLO E2 closed)
- [ ] Consumer upgrade PRs opened/nudged — no surface > 1 minor-era behind (SLO E3)
