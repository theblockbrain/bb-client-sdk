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

## Release

Tag `vX.Y.Z` on main. Apps pin `#main` for latest or `#vX.Y.Z` for stability.
