# @theblockbrain/bb-client-sdk

Shared frontend SDK for BlockBrain apps (Chrome extension, Outlook add-in, future apps).

## Install

```sh
# .npmrc (project-level, committed — no token here)
@theblockbrain:registry=https://npm.pkg.github.com

# ~/.npmrc (machine-level, not committed)
//npm.pkg.github.com/:_authToken=<PAT (classic) with read:packages>
```

```jsonc
// package.json
"dependencies": {
  "@theblockbrain/bb-client-sdk": "^0.18.0"
}
```

The package is published to GitHub Packages (private, `theblockbrain` org). Consumers need a GitHub PAT with `read:packages` scope configured locally, and their repo must be granted access under the package settings.

## Sub-path imports

```ts
import { generateVerifier, login }   from "@theblockbrain/bb-client-sdk/auth";
import { fetchBotList, sendMessage }  from "@theblockbrain/bb-client-sdk/api";
import { getAuthContext, Settings }   from "@theblockbrain/bb-client-sdk/settings";
import { extractJson, extractCode }   from "@theblockbrain/bb-client-sdk/text";
import type { StorageAdapter, IdentityAdapter } from "@theblockbrain/bb-client-sdk/adapters";
import { AUTH_AUTHORITY, TOKEN_ENDPOINT }       from "@theblockbrain/bb-client-sdk/config";
```

## Adapter pattern

Platform-specific I/O is injected via two interfaces. Implement them in your app, pass them to SDK functions:

```ts
// StorageAdapter — implement with chrome.storage.local, localStorage, etc.
const storage: StorageAdapter = {
  get: async (k) => (await chrome.storage.local.get(k))[k] ?? null,
  set: async (k, v) => chrome.storage.local.set({ [k]: v }),
  remove: async (k) => chrome.storage.local.remove(k),
};

// IdentityAdapter — implement with chrome.identity, Office.Dialog, etc.
const identity: IdentityAdapter = {
  getRedirectUri: () => chrome.identity.getRedirectURL(),
  launchOAuthFlow: (url) => chrome.identity.launchWebAuthFlow({ url, interactive: true }),
};

// High-level login flow
const result = await login(identity);
// result: { access_token, refresh_token, id_token, expiresAt, profile, orgId }
```

## Build

```sh
npm install
npm run build     # outputs dist/
npm run typecheck # strict TS, 0 errors
```

> **Consuming this SDK via a local `file:` link** (e.g. the Chrome add-in): `dist/` is
> git-ignored (it's built fresh on publish), and npm does **not** run build scripts for
> symlinked `file:` dependencies — a `prepare` script won't cover it. So after a fresh
> clone or pull of this SDK, run `npm run build` here **once** before building the linked
> consumer, otherwise its import of `dist/` resolves to nothing.

## Error handling

All SDK API calls throw `BBApiError` on non-2xx HTTP responses:

```ts
import { fetchBotList, BBApiError } from "@theblockbrain/bb-client-sdk/api";

try {
  const bots = await fetchBotList(ctx);
} catch (err) {
  if (err instanceof BBApiError) {
    if (err.statusCode === 401) { /* re-auth */ }
    console.error(err.endpoint, err.responseBody);
  } else {
    throw err;
  }
}
```

**Migration from pre-v0.3.0:** Code that parsed `err.message` to extract the HTTP status
(`err.message.match(/API (\d+)/)`) should switch to `err.statusCode` directly.
`BBApiError extends Error`, so existing `instanceof Error` checks continue to work.

## Tenant listing (admin-only)

Requires a master-org token. `listTenants` returns summaries — no `zitadelOrgId`.
Call `getTenantById` when you need the org-id for tenant-scoped API calls.

```ts
import { listTenants, getTenantById } from "@theblockbrain/bb-client-sdk/api";

const { data, totalCount } = await listTenants(ctx, { name: "datev", page: 1, size: 50 });

// Fetch zitadelOrgId for a specific tenant
const detail = await getTenantById(ctx, data[0].id);
// detail.zitadelOrgId — pass as orgId for tenant-scoped ctx
```

## Web search

Toggle web search on a conversation:

```ts
import {
  getAvailableWebSearchProviders,
  setConversationWebSearch,
  getConversationWebSearch,
} from "@theblockbrain/bb-client-sdk/api";

// Which providers are enabled for this tenant?
const providers = await getAvailableWebSearchProviders(ctx);

// Enable web search on a conversation
await setConversationWebSearch(ctx, convoId, {
  enableWebSearch: true,
  webSearchType: "normal_web_search",
  webSearchConfig: { webSearchProvider: "tavily_normal_web_search" },
});

// Read current settings
const settings = await getConversationWebSearch(ctx, convoId);
```

## Message history

```ts
import { getMessageList } from "@theblockbrain/bb-client-sdk/api";

const { data, total } = await getMessageList(ctx, convoId, { page: 1, size: 50 });
// data: MessageItem[] — each has .role + .content
```

## extractJson

Parse JSON from LLM output — handles markdown fences, embedded JSON in prose, and
unescaped quotes inside string values:

```ts
import { extractJson } from "@theblockbrain/bb-client-sdk/text";

extractJson('```json\n{"a":1}\n```')              // { a: 1 }
extractJson('Result: {"name":"foo \\"bar\\""}')    // { name: 'foo "bar"' }
extractJson("garbage")                             // null — never throws
```

Returns `T | null`. Callers must handle `null` — never throws.

## Browser SPA login (full-page redirect)

For plain browser SPAs (Vite, CRA, etc.) without a popup container:

```ts
import { beginBrowserLogin, completeBrowserLogin } from "@theblockbrain/bb-client-sdk/auth";

// On app init:
const result = await completeBrowserLogin({
  clientId: "<your zitadel client id>",
  authorizeEndpoint: "https://auth.dev.theblockbrain.ai/oauth/v2/authorize",
  tokenEndpoint: "https://auth.dev.theblockbrain.ai/oauth/v2/token",
  redirectUri: `${window.location.origin}/`,
});

if (result.isCallback) {
  // Just logged in — store tokens
  sessionStorage.setItem("access_token", result.access_token);
}

// On login button click:
await beginBrowserLogin({ clientId, authorizeEndpoint, tokenEndpoint, redirectUri });
// Never returns — page navigates to Zitadel
```

## Theme system (React)

`/ui` exports one theme mechanism: the `useTheme` hook, which writes
`<html data-theme="light|dark|system">`. There is exactly one activation and one
attribute — see *Why `system` is not resolved in JS* below.

```tsx
import { useTheme, nextThemeMode } from "@theblockbrain/bb-client-sdk/ui";

function Header() {
  const [theme, mode, cycleTheme] = useTheme(); // default key: "bb-theme"
  // Per-tool key prevents cross-tool collisions on the same origin:
  // const [theme, mode, cycleTheme] = useTheme("bb-dashboard-theme");

  // `theme` is "light" | "dark" (system already resolved) — for JS branching.
  // `mode`  is "light" | "dark" | "system" — the user's explicit preference.
  return (
    <button type="button" onClick={cycleTheme} aria-label={`Theme: ${mode}`}>
      {mode}
    </button>
  );
}
```

The SDK deliberately ships **no toggle component**. Any component styled in
default Tailwind palette classes (`bg-neutral-700`, `text-stone-300`) renders
unstyled wherever `@botticelli/blokkit` is also loaded, because blokkit's
generated `tailwind-reset.css` sets `--color-*: initial` and deletes that
palette. Build the button in your surface, where you know which palette exists.
`nextThemeMode(current)` is exported so you do not have to re-derive the
light → dark → system cycle order.

### Why `system` is not resolved in JS

`useTheme` writes the user's preference to `data-theme` **verbatim**, including
`system`. It does not collapse `system` to `light`/`dark`. That is deliberate:
blokkit's dark variant resolves `system` in CSS, with its own media query.

```css
@custom-variant dark {
  &:where([data-theme="dark"] *, [data-theme="dark"]) { @slot; }
  &:where([data-theme="system"] *, [data-theme="system"]) {
    @media (prefers-color-scheme: dark) { @slot; }
  }
}
```

Write a resolved value instead and that second branch never matches, so dark
mode silently stops following the OS. The hook's first return value gives you
the resolved theme when JS genuinely needs to branch on it.

### Shared CSS

Import the base stylesheet in your app's CSS (after `@import "tailwindcss"`):

```css
@import "@theblockbrain/bb-client-sdk/ui/theme-base.css";
```

This provides `.animate-fade-in`, `.dot-grid-*`, and scrollbar styles keyed on
`data-theme`. It does **not** declare `@custom-variant dark` — that used to
collide with blokkit's identically-named variant (two definitions, two
selectors, last import wins). If your surface uses blokkit, it already has the
variant; if it does not, copy the block above into your CSS once.

### Tailwind v4 — `@source` directive

The SDK no longer ships components carrying Tailwind classes, so the `@source`
directive is only needed if you extend the SDK's CSS with your own utility
classes. It is harmless to keep:

```css
/* In your app's main CSS file, after @import "tailwindcss" */
@source "../node_modules/@theblockbrain/bb-client-sdk/dist";
```

### `storageKey` parameter

Pass a per-tool key to avoid localStorage collisions when multiple BB tools
share the same origin:

| Tool | Recommended key |
|------|-----------------|
| bb-batch-analyzer | `"bb-theme"` (default) |
| bb-dashboard | `"bb-dashboard-theme"` |
| chrome-addon | handled via chrome.storage — custom hook |

## Testing an unreleased change in a consumer

Entry points routinely live on `main` before they are published, and a consumer pinning `^0.18.0`
resolves to the newest published tag and **cannot import them**. (`./agentic`, `./analytics`,
`./analytics/mixpanel`, `./i18n`, `./media` and `./telemetry` all postdated `v0.17.0` and ship in
`0.18.0`.) Testing an unreleased change needs one of the three routes below. Pick by blast radius:
local link → canary → release.

**1. `file:` link — no publish, fastest, includes uncommitted work.** npm points the consumer's
`node_modules` entry at your local SDK checkout, so the surface builds against the exact `dist/`
you have on disk — uncommitted changes included. Nothing is published and no version number is
involved, which makes it the right choice for "does this actually work in a real Office.js
webview / SPFx / RN runtime". Use `npm install --no-save file:../bb-client-sdk` (surfaces should
expose it as an `sdk:link` script): **`--no-save` leaves `package.json` and `package-lock.json`
byte-identical**, so a `file:` pin can never be committed by accident, and any later
`npm install`/`npm ci` drops the link automatically. The one gotcha that catches everyone:
`dist/` is git-ignored **and npm does not run `build` for a linked dependency**, so you must
`npm run build` here yourself — and again after every change.

**2. Canary publish — a real version, `latest` untouched.** Adding the `release:canary` label to
an SDK PR runs [`canary.yml`](.github/workflows/canary.yml), which publishes
`0.0.0-canary.<short-sha>` under the `canary` dist-tag. Because that is a prerelease of `0.0.0`,
no semver range ever resolves to it — a consumer must ask for `@canary` or the exact version by
name, so stable consumers cannot drift onto it by accident. Use this when the code must travel:
another person, another machine, or a consumer's CI. It publishes the **committed branch head**,
not your working tree, gates only on `typecheck` + `build`, and the version is computed in the
runner (your `package.json` is never modified). Re-labelling the same commit fails — the registry
refuses a duplicate version — so push a new commit or re-run via `workflow_dispatch`.

**3. Cut a real release — the end state, and the highest blast radius.** A `vX.Y.Z` tag on `main`
publishes to the `latest` dist-tag, where every consumer's `^` range can pick it up. New entry
points are **additive → MINOR**, and at `0.x` a minor is this package's major (`^0.18.0` locks to
`<0.19.0`), so new subpaths ship as `0.19.0` — never as a patch, which would silently upgrade
every `^0.18.x` consumer with no opt-in. Do this only after a canary or link has been validated in
a real consumer: `publish.yml` re-runs the full gate on the tag (PDEV-7001), but a gate proves the
package builds — only a consumer proves the change works.

### Chronological steps

**Option 1 — `file:` link** (run in the SDK repo, then the consumer):

```sh
# 1. HERE — required after every SDK change (npm won't build a linked dep; dist/ is git-ignored)
nvm use && npm run build

# 2. IN THE SURFACE — once per clone. --no-save keeps package.json + the lockfile untouched.
cd ../ms-outlook-addin
npm run sdk:link                          # = npm install --no-save file:../bb-client-sdk
npm run dev                               # restart so the bundler re-resolves; then sideload

# 3. after each further SDK change — rebuild here, reload there. No reinstall.
cd ../bb-client-sdk && npm run build

# 4. rollback
cd ../ms-outlook-addin && npm run sdk:unlink   # = npm ci, restores the published version
```

Two things to verify once, per surface, the first time you link it: `git status` must show **no**
change to `package.json`/`package-lock.json` (if it does, someone used `npm install file:…`
without `--no-save`), and the bundler must **dedupe `react`/`react-dom`** — Node resolves a
symlinked package's bare imports from the SDK's *own* `node_modules`, where React is a
devDependency, so a React consumer will otherwise load two copies and fail with "Invalid hook
call". In Vite that is `resolve.dedupe: ["react", "react-dom", "@tanstack/react-query"]`.
Do **not** substitute a bundler alias for the link: an alias bypasses the `exports` map, so a
subpath can appear to work locally while being broken for real consumers.

**Option 2 — canary**:

```sh
# 1. commit + push everything you want included (the workflow builds the branch HEAD, not your tree)
git push -u origin <your-branch>

# 2. trigger it — either the label on the PR…
gh pr edit <PR> --repo theblockbrain/bb-client-sdk --add-label "release:canary"
#    …or from any ref, no PR needed:
gh workflow run "Canary release" --repo theblockbrain/bb-client-sdk --ref <your-branch>

# 3. the workflow comments the install line on the PR; in the consumer:
npm install @theblockbrain/bb-client-sdk@0.0.0-canary.<short-sha>   # exact build
npm install @theblockbrain/bb-client-sdk@canary                     # newest canary

# 4. rollback in the consumer:
npm install @theblockbrain/bb-client-sdk@^0.18.0
```

> Consumer notification is **manual**: `canary.yml`'s `notify-consumers` job is dormant until an
> org GitHub App token exists (PDEV-6806), because the default `GITHUB_TOKEN` cannot trigger
> workflows in another repo. Publishing a canary does not test anything by itself — someone still
> installs and builds it.

**Option 3 — release**:

```sh
# 1. full local gate on the exact SHA (mirrors ci.yml; publish.yml will NOT re-run these)
nvm use && npm ci
npm run lint && npm run typecheck && npm test && npm run build && npm run check:package

# 2. confirm ci.yml itself went green on that merged main commit
gh api "repos/theblockbrain/bb-client-sdk/commits/$(git rev-parse HEAD)/check-runs" \
  --jq '.check_runs[] | "\(.name): \(.status)/\(.conclusion)"'

# 3. bump + tag from main
npm version minor --no-git-tag-version    # new entry points are additive → MINOR (0.18.0)
git commit -am "chore: release v0.18.0" && git tag v0.18.0 && git push --follow-tags

# 4. consumers move their pin deliberately
npm install @theblockbrain/bb-client-sdk@^0.18.0
```

See [`.claude/skills/sdk-release/SKILL.md`](.claude/skills/sdk-release/SKILL.md) for the full
pre-release gate, and [`references/release-and-versioning.md`](.claude/skills/sdk/references/release-and-versioning.md)
for the semver-for-fan-out table.

## Release

Push tag `vX.Y.Z` on main — the publish workflow triggers automatically and publishes to GitHub
Packages. `publish.yml` re-runs the full gate on the tag (version guard → lint → typecheck → test →
build → `check:package` → `check:cleanroom`) and refuses to publish if the tag does not match
`package.json`. Run the gate locally anyway, so a failure costs a minute rather than a burnt tag.
Steps: [Option 3](#chronological-steps) above.
