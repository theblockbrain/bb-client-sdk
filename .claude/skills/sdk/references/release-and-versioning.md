---
name: sdk-release-and-versioning
description: >-
  Use when cutting, tagging, or publishing a @theblockbrain/bb-client-sdk
  release; when deciding whether a change is breaking (major) vs additive
  (minor); when running or updating the public-API contract snapshot; when
  wiring the canary flow to test in a consumer before `latest`; or when a
  consumer (Outlook, Word, Slack, blocky-mobile, …) needs to pin, upgrade,
  or link the package. Dual audience — maintainers cut releases; adapter
  devs consume and upgrade.
---

# Release & Versioning — how a change safely becomes a version consumers can adopt

> **Inherits from**: `/sdk` — see that skill for the adapter matrix, the
> cross-cutting invariants (A–E), and the verification loop. This doc does not
> repeat them; it covers only the release/versioning mechanics and links back.
>
> - Adapter matrix (which runtimes/auth/storage a change touches): [`./adapters.md`](./adapters.md)
> - Org code-style baseline (import order, no `any`, verification checklist): **Code Cleanup & Refactoring** standard

**The core fact that governs everything here:** this package fans out to ~11+
surfaces (Outlook/Word/PowerPoint/Excel add-ins, SharePoint SPFx, Slack backend,
blocky-mobile RN, blocky-chat Lit, blocky-frontend SPA, the reference repos).
Semver ranges (`^0.x`) mean **a breaking change propagates silently** on the
next `npm install`. A version is a contract with every one of those surfaces at
once — treat it that way.

---

## 1. The SemVer contract for a fan-out package

The public surface is the JS entry points declared in `package.json`
`"exports"` — **13 today** (`.`, `./auth`, `./api`, `./settings`, `./utils`, `./adapters`,
`./config`, `./prompt`, `./actions`, `./ui`, `./react`, `./analytics`, `./analytics/mixpanel`;
the `./ui/theme-base.css` asset subpath is not a module surface). The last two are on `main`
but **not in a published release** — the newest tag, `v0.17.0`, predates them.
Anything reachable through those
subpaths — every exported value **and type** — is the contract. Internal files
not re-exported from an entry `index.ts` are not.

### What counts as breaking (MAJOR) vs additive (MINOR) vs neutral (PATCH)

| Change | Bump | Why |
| --- | --- | --- |
| Remove or rename an exported symbol or type from any entry point | **MAJOR** | Consumer imports fail to resolve / typecheck |
| Change a function signature (param added-as-required, type narrowed, return widened) | **MAJOR** | Existing call sites break at compile or runtime |
| Change **runtime behavior** of a stable export (e.g. `extractJson` starts throwing, `getAuthContext` changes which `baseUrl` wins, `BBApiError` field renamed) | **MAJOR** | Behavior is part of the contract even when the signature is unchanged |
| Change an event-taxonomy name, header, or wire shape a surface depends on (`x-zitadel-org-id`, `?orgId=`, Blocky `new_token`→`message_ready`) | **MAJOR** | Cross-surface protocol break; see invariant D |
| Move a symbol between entry points (e.g. `./utils` → `./auth`) | **MAJOR** | The import path is part of the contract |
| Add a **new** export, a new optional param, a new entry point | **MINOR** | Purely additive; old code still compiles |
| Add a new optional field to a returned object | **MINOR** | Additive |
| Bug fix with no surface/behavior change; docs; internal refactor | **PATCH** | Contract unchanged |
| Widen/relax an input type, add an optional adapter method | **MINOR** | Additive |
| Drop a Node version, raise a peer range, change ESM/CJS shape | **MAJOR** | Consumer environment/toolchain contract |

> **Pre-1.0 caveat (we are `0.17.0`).** Under strict semver, `0.x` allows breaking
> changes in a **minor**. We do **not** rely on that leniency: because consumers
> pin `^0.x` (which under npm's rules locks the **minor**, e.g. `^0.17.0` →
> `<0.18.0`), a breaking change **must** land as a **minor** bump (`0.17` → `0.18`)
> **with a documented migration note**, never as a patch. Treat a `0.x` minor bump
> as this package's "major". When the package reaches `1.0.0`, breaking → real MAJOR.

### The tripwire: the public-API contract test

`src/public-api.contract.test.ts` snapshots the exported names (values **and**
types) of every JS entry point, and the entry list is **derived from
`package.json` "exports"** so it cannot drift from the publish surface. The
snapshot lives at `src/__snapshots__/public-api.contract.test.ts.snap`. It uses
the TypeScript checker (`getExportsOfModule`) rather than runtime keys precisely
so that **type-only** entry points like `./adapters` (all `export type …`) are
still guarded.

- A rename/removal fails the snapshot in CI → forces a **conscious** decision
  instead of a silent break. This is the anti-breakage mechanism for a package
  that fans out to every surface.
- To change the API on purpose, **update the snapshot in the same PR**:
  `npx vitest -u` (or `npx vitest run -u src/public-api.contract.test.ts`), and
  a snapshot diff in review = a semver decision. A snapshot diff with **no
  version bump and no migration note** is a review blocker.

### The rule

> A change that alters the contract (any row marked MAJOR above, or the `0.x`
> minor-as-major rule) requires **(a)** the version bump, **(b)** a migration
> note (see §3), **and (c)** canary validation in a real consumer (Outlook)
> **before** it becomes `latest`. No exceptions. The contract snapshot is the
> gate that makes this non-optional.

---

## 2. Canary flow — test in a consumer before `latest`

`.github/workflows/canary.yml` exists so a surface can build against an SDK
change **before** any real release. Use it for **every** contract-affecting
change and any change that touches the transport/auth/streaming seams.

**Trigger:** add the **`release:canary`** label to the PR (or run the workflow
manually via `workflow_dispatch` on the Actions tab).

**What it does:**
1. Checks out the PR head SHA.
2. Quick gate: `npm ci` → `npm run typecheck` → `npm run build` (so a broken
   canary never publishes).
3. Sets a non-committed version `0.0.0-canary.<short-sha>` via
   `npm version … --no-git-tag-version`.
4. `npm publish --tag canary` — publishes under the **`canary`** dist-tag. It
   **never** touches `latest`; stable consumers are unaffected.
5. Comments install instructions on the PR:
   `npm install @theblockbrain/bb-client-sdk@0.0.0-canary.<sha>` (exact build) or
   `@canary` (moving tag → newest canary).

**Then test it in Outlook** (the reference adopter) — install the canary in
`ms-outlook-addin`, build, and exercise the affected flow against the adapter
matrix in [`./adapters.md`](./adapters.md): does auth/storage/streaming still
work in the Office.js webview? Only after a consumer builds green do you cut the
real tag.

> **Dormant piece — do not assume it fires.** The `notify-consumers` job (which
> would dispatch an `sdk-canary` event into consumer repos so their CI installs
> `@canary` automatically) is gated on `vars.CONSUMER_DISPATCH_ENABLED == 'true'`
> and needs an org **GitHub App** token (`secrets.CONSUMER_DISPATCH_TOKEN`) —
> the default `GITHUB_TOKEN` cannot trigger cross-repo workflows. Until PDEV-6806
> wires that App, **canary consumer testing is manual**: install and build in the
> consumer yourself.

---

## 3. Publish flow — and the known gap

### How a release is cut (maintainers)

Follow these phases exactly.

**Phase 0 — Preflight (local, on a merged `main`).**
- Confirm Node 24 (`.nvmrc` = `24.18.0`, `engines.node >=24`). Use `nvm use`.
- `npm ci && npm run lint && npm run typecheck && npm test && npm run build && npm run check:package`
  — i.e. reproduce the full `ci.yml` gate locally, **including** the parts
  `publish.yml` will skip (see the gap below).
- Confirm the contract snapshot is committed and matches the intended surface.

**Phase 1 — Canary + consumer validation.** Done in §2 while the change was still
a PR. Do not skip for contract-affecting changes.

**Phase 2 — Version bump + migration note.**
- Bump `package.json` `version` per §1 (breaking → `0.x` **minor**; additive →
  minor; fix → patch).
- If it is breaking, add a **migration note** (README/CHANGELOG entry: what
  changed, the before→after call site, which surfaces must act).
- Commit on a ticket-scoped branch (§5): `chore(PDEV-XXXX): release v0.18.0`.
  (The `pre-push` hook already tolerates `release*` / `release-please` branch
  names for future automated tooling; none is wired today — releases are cut
  manually.)

**Phase 3 — Tag & publish.**
- Tag `vX.Y.Z` on the release commit and push the tag:
  `git tag v0.18.0 && git push origin v0.18.0`.
- Pushing a `v*` tag triggers `.github/workflows/publish.yml`:
  `npm ci` → `npm run typecheck` → `npm run build` → `npm publish` (to
  GitHub Packages, `access: restricted`, via the built-in `GITHUB_TOKEN`).

### ⚠ KNOWN GAP — publish is not gated on the full CI

`publish.yml` runs **only `typecheck` + `build`**. It does **not** run `test`,
`lint` (biome + eslint), or `check:package` (publint + attw). `ci.yml` runs the
full gate — but only on push/PR to `main`, **not** on the `v*` tag. So:

- Cutting a release does **not** currently re-run tests, lint, the **public-API
  contract test**, or the package-export checks. A tag on a commit whose tests
  never went green (or a tag on a non-`main` commit) can publish a broken
  `latest`. Today `ci.yml`-on-`main` is the only safety net, and it is not
  enforced at publish time.

**Prescribed fix (SLO E2 — "CI + publish both gated on tests"):**

1. **Preferred — one gate, two callers.** Extract the CI steps
   (`lint:biome` → `lint:types` → `typecheck` → `test` → `build` →
   `check:package`) into a **reusable workflow** (`workflow_call`) and have both
   `ci.yml` and `publish.yml` invoke it via `jobs.<id>.uses`. Publish's
   `npm publish` step then `needs:` the gate job → the two workflows cannot
   drift, and no release publishes without the full suite passing.
2. **Alternative — require green CI on the tagged SHA.** Before publishing,
   assert that the `CI` workflow concluded `success` for the tagged commit (e.g.
   query `gh api` for the check-run status of `github.sha`) and fail the publish
   job otherwise. Cheaper, but re-runs nothing and only works if the tag sits on
   an already-tested `main` commit.

Until one of these lands, **Phase 0's local full-gate run is mandatory**, not
optional — it is the manual stand-in for the missing publish gate. Flag this gap
in any release PR that touches the workflows.

---

## 4. Consumer adoption guidance (adapter devs)

### Pin policy

| Do | Don't |
| --- | --- |
| Pin `^0.MINOR.PATCH` (e.g. `^0.17.0`) so patches flow but a breaking minor does not arrive un-reviewed | Pin `*`, `latest`, or a range that crosses a minor (`>=0.17`) |
| Read the migration note and bump the minor deliberately | Let a stale pin drift far behind (see the Outlook lesson) |
| Use `@canary` / `@0.0.0-canary.<sha>` to trial an unreleased change | Ship a canary build to production |

Install prerequisites (README): a project-level committed `.npmrc`
(`@theblockbrain:registry=https://npm.pkg.github.com`) plus a machine-level
`~/.npmrc` auth token — a **PAT (classic) with `read:packages`**, and the
consumer repo must be granted access under the package settings. Never commit
the token.

### The stale-pin lesson (cautionary tale)

`ms-outlook-addin` — the **reference adopter** — sat on **`^0.7.3`** while the SDK
reached **`0.17.0`**: ~10 minor eras behind. It was brought current in July 2026 and
now pins **`^0.17.0`**, but the consequences of that drift map directly to the
invariants and are why SLO E3 below exists:

- A drifted surface cannot canary-test current changes (its code assumes an old
  surface), so it stops being a reliable pre-`latest` signal — the very thing
  §2 depends on.
- Every accumulated breaking change lands in **one** painful upgrade instead
  of being absorbed incrementally.
- Under `^` ranges a breaking change would otherwise fan out **silently**; a
  frozen pin trades that for an ever-growing migration debt.

**SLO E3 — "no surface more than one minor-era behind."** Every consuming surface
should track within one minor of the current SDK. An upgrade PR per surface each
release era is cheap; a 10-era jump is not.

### Local `file:` link build gotcha

When a consumer links this SDK via a local `file:` dependency (e.g. Chrome
add-in, or any monorepo-style link), `dist/` is **git-ignored** and npm does
**not** run build scripts for symlinked `file:` deps — a `prepare` script won't
cover it. **After any fresh clone or pull of this SDK, run `npm run build` here
once** before building the linked consumer, or its `import` of `dist/` resolves
to nothing. (This only affects `file:` links; registry installs ship a built
`dist/` because `prepack`/`prepublishOnly` build it.)

---

## 5. Commit & branch governance (enforced by lefthook)

Every change that becomes a release rides these rails. Hooks are installed via
`prepare` → `lefthook install`.

| Hook | Rule | Example | Exempt |
| --- | --- | --- | --- |
| `commit-msg` | Conventional Commit **scoped by a Jira ticket key**: `type(TICKET-123): summary`. `type` ∈ feat/fix/chore/docs/style/refactor/perf/test/build/ci/revert. A `!` before the colon marks a breaking change (`feat(PDEV-123)!: …`). | `feat(PDEV-6802): add AnalyticsAdapter seam` | messages starting `Merge ` / `Revert ` |
| `pre-commit` | Biome (format + base lint) on staged files only — kept fast; the heavy type-aware gate runs in CI | — | — |
| `pre-push` | Branch name `type/TICKET-123/description` | `feat/PDEV-123/react-query-layer` | `main`, `release*`, `release-please*` |

Notes:
- The `lefthook.yml` header comment mentions "free-form scopes"; the **enforced
  regex requires a ticket key** — follow the regex, not the stale comment.
- Use the breaking-change marker `!` on the commit that lands a MAJOR/`0.x`-minor
  contract change, so the history makes the semver decision auditable.
- CI (`ci.yml`) — not the hooks — is the real merge gate, together with branch
  protection. Hooks are the fast local first line.
- **Node 24** everywhere: `.nvmrc` (`24.18.0`), `engines.node >=24`, and every
  workflow reads `node-version-file: ".nvmrc"`. Build/test/publish on anything
  older is unsupported.

---

## Quick checklist (paste into a release PR)

- [ ] Contract snapshot reviewed; diff intentional and version-bumped (or no diff)
- [ ] Semver decision made per §1 (breaking → `0.x` **minor** + migration note)
- [ ] Migration note written (before→after + affected surfaces) if breaking
- [ ] `release:canary` label added; canary built **green in Outlook** (or the
      surface the change targets) — see [`./adapters.md`](./adapters.md)
- [ ] Phase 0 full local gate run green (`lint` + `typecheck` + `test` + `build`
      + `check:package`) — stand-in for the publish.yml gap
- [ ] Version bumped; commit + branch follow the ticket-scoped convention (§5)
- [ ] Tag `vX.Y.Z` pushed on the release commit; `publish.yml` succeeded
- [ ] (If touching workflows) publish-gap fix considered per §3 / SLO E2
