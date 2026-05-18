# @theblockbrain/bb-client-sdk

Shared frontend SDK for BlockBrain apps (Chrome extension, Outlook add-in, future apps).

## Install

```jsonc
// package.json — via Git URL (private repo)
"dependencies": {
  "@theblockbrain/bb-client-sdk": "github:theblockbrain/bb-client-sdk#main"
}
```

## Sub-path imports

```ts
import { generateVerifier, login }   from "@theblockbrain/bb-client-sdk/auth";
import { fetchBotList, sendMessage }  from "@theblockbrain/bb-client-sdk/api";
import { getAuthContext, Settings }   from "@theblockbrain/bb-client-sdk/settings";
import { siteKey, createLock }        from "@theblockbrain/bb-client-sdk/utils";
import type { StorageAdapter, IdentityAdapter } from "@theblockbrain/bb-client-sdk/adapters";
import { AUTH_CLIENT_ID, TOKEN_ENDPOINT }       from "@theblockbrain/bb-client-sdk/config";
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

## Error handling

All SDK API calls throw `BBApiError` on non-2xx HTTP responses:

```ts
import { fetchBotList, BBApiError } from "@theblockbrain/bb-client-sdk/api";

try {
  const bots = await fetchBotList(ctx);
} catch (err) {
  if (err instanceof BBApiError) {
    if (err.statusCode === 401) { /* re-auth */ }
    if (err.statusCode === 503) { /* not configured */ }
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
import { extractJson } from "@theblockbrain/bb-client-sdk/utils";

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

## Release

Tag `vX.Y.Z` on main. Apps pin `#main` for latest or `#vX.Y.Z` for stability.
