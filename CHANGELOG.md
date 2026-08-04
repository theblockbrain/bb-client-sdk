# Changelog

## 0.19.0 — a React-free root barrel

### ⚠️ Breaking: `useTheme` moved to `./ui/react`

The only symbol that leaves its old home. `./ui` is now React-free and everything
else on it is unchanged, including on the root barrel.

```diff
-import { useTheme } from "@theblockbrain/bb-client-sdk/ui";
+import { useTheme } from "@theblockbrain/bb-client-sdk/ui/react";
```

`Theme` and `ThemeMode` are re-exported from both subpaths, so a type-only import
needs no change.

**Why.** Importing `"."` from Node with no React installed threw
`Cannot find package 'react'` — that is `bb-slack-integrations`' exact situation.
The root barrel re-exported `./ui`, which re-exported `useTheme`, which imports
React. Invariant A says `./api` and `./auth` tree-shake with zero React in the
graph; the shipped artifact did not honour it for `.`, and no gate caught it
because the clean-room check installs the peers before probing.

Re-exporting *anything* from a module that imports React pulls React in, so the
pure `nextThemeMode` and the `Theme`/`ThemeMode` vocabulary moved to their own
`theme-mode.ts` — leaving them beside the hook was enough to break the layer on
its own.

The root barrel keeps re-exporting `./ui`, which is safe once the hook is gone:
`markdownToHtml`, `renderMarkdown`, `renderMarkdownInto`, `MarkdownOptions`,
`timeAgo` and `nextThemeMode` all stay on `"."`. Dropping the whole layer would
have removed seven working exports to fix one.

### `react` peer widened to `>=18 <20`

Was `^19.2.7`, which made React 18 an install-time failure unrelated to the code.
Verified against `react@18.3.1` + `@types/react@18.3.12`: typecheck passes and the
whole suite passes, so nothing in `src` uses a React-19-only API. Matches blokkit.

### `react-native` export conditions

Every entry now declares a `react-native` condition ahead of `import`. It resolves
to the same artifact today — the point is that a per-platform implementation
becomes possible without a further breaking change, and adding the condition after
consumers pin is the disruptive order.

### `sideEffects`

Now declared as `["**/*.css"]`. Previously absent, so bundlers could not drop
unused modules from a consumer's graph.

### `SyncStorageAdapter` — storage is now actually behind the port

`useTheme` reached `localStorage` and `beginBrowserLogin` / `completeBrowserLogin`
reached `sessionStorage` directly, so "storage is always via `StorageAdapter`"
(invariant B) was documented but not true. Both now go through a port.

The existing `StorageAdapter` could not serve them: it is `Promise`-only, and
`useTheme` reads inside a `useState` initialiser. Hence a second, **synchronous**
port — the same reason zustand's `PersistStorage` is synchronous, and the reason a
surface given only the async port writes its own storage layer instead.

`SyncStorageAdapter` is string-valued, matching Web Storage and zustand's
`StateStorage`. `createWebStorageAdapter(area)` is a pass-through, so **the stored
bytes are unchanged** — existing preferences keep reading and a pre-paint theme
script sharing the key keeps working.

Additive: `useTheme(storageKey, storage?)` and `BrowserRedirectOptions.storage` are
both optional and default to the previous behaviour.

### New `./i18n` subpath: message keys + a formatter port (L12)

The SDK owns the **vocabulary**, not the strings. `BBMessageKey` is a closed union
so `Record<BBMessageKey, string>` makes a missing translation a compile error in the
surface; catalogues stay with each surface. `describeBBApiError` now returns a `key`
alongside `title`/`detail`, so its English output is a default rather than the only
option.

`FormatterAdapter` wraps dates, numbers and relative time, defaulting to `Intl`
resolved lazily so the module imports where `Intl` is absent or partial (Hermes
without `hermes-intl`). Every method falls back rather than throwing.

**`timeAgo` is unchanged and not routed through the port.** It emits `"5m ago"`;
`formatRelativeTime` emits `"5 minutes ago"`. Swapping one for the other would change
every rendered timestamp in every surface, so surfaces opt in.

### Cache policy moved out of the React layer (L13)

TTLs lived as literals inside `react/provider.tsx` — React-only and unreadable, so a
Lit or Node surface could not honour the same freshness rules. `BB_CACHE_POLICY` on
`./settings` is now per-resource and framework-agnostic; `provider.tsx` and the
`messages` override read from it.

Behaviour is unchanged for every resource that had no override. Two now differ
deliberately: `tenantConfig` and `capabilities` move to 30 minutes, since they change
on an admin action rather than a navigation.

### New host ports: crypto, host capabilities, feature flags

**`CryptoAdapter` (L7).** The SDK reached `crypto.randomUUID`, `crypto.getRandomValues`
and `crypto.subtle.digest` on the global at seven sites — two on the mainline
send-message path — with no injection point. On React Native that is a hard crash,
not a degradation: Hermes has no Web Crypto and Expo's runtime does not install it.
`setCryptoAdapter()` now accepts a host implementation; the default resolves the
global lazily, so browser behaviour is unchanged. `digest` is pinned to SHA-256 so a
host can satisfy it without a full WebCrypto polyfill.

**`HostCapabilityRegistry` (L7).** Signatures and a router for tool calls only a host
can serve (read the open mail item, insert at the Word cursor). No Office.js or Graph
type enters the SDK. `routeToolCall` never throws — an unknown tool is a normal
condition, since the agent can be newer than the host, and an exception there would
tear down the turn.

**`FlagAdapter` (L10).** A synchronous, total feature-flag port. Reads happen on a
render path, so they cannot await; a throwing or absent provider degrades to the
caller's fallback rather than breaking the feature it was meant to gate.

### `describeBBApiError` + `isRetryableBBError` (L9)

One status ladder instead of one per surface — `ms-outlook-addin` carries three
near-identical copies in a single file. `describeBBApiError` returns
`{ title, detail, retryable }` and deliberately ignores the response body and the
error message, since server text can echo a submitted grant and this output is
rendered. `bbShouldRetryQuery` now delegates to `isRetryableBBError`, so the query
client, the transport's retry policy and any surface's error UI cannot drift apart.

`503` gets no special case. It was documented as "capability not configured", but
that meaning has no source: Botticelli emits 503 **nowhere** (0 occurrences across
`packages/`, any language or config), no consumer branches on it, and the claim
entered as a comment in a README example. With no application path emitting it, the
realistic source is infrastructure mid-rollout — transient, and retryable per RFC
9110. Removed from the README and the /sdk skill.

### The gate that would have caught all of this

`npm run check:cleanroom` gained a second phase that installs the tarball with
**no** React and imports every entry point. It also asserts `./react` and
`./ui/react` *do* fail there — if they ever stop failing, React has stopped being
a real peer and the split has lost its meaning.

---

## 0.18.0 — the consolidation baseline

The first release since `v0.17.0` (2026-06-23), and the baseline every adapter
migration builds on. It carries the whole of **WS2** (one transport for every
call), the **rename cluster**, and a set of security fixes.

Breaking changes are batched into this single bump on purpose. Every one of them
is breaking, and three repos install this package — spreading them across several
minors would make consumers pay the migration tax repeatedly.

---

## ⚠️ Read this first: five breaking changes CI cannot see

`src/public-api.contract.test.ts` compares **exported symbol names**. The five
below either keep their name or change something the snapshot has no view of, so
**no diff in any pull request shows them**. They are listed first for that reason.

### 1. `ThemeMode`'s `"auto"` value is now `"system"`

The type name is unchanged, so the snapshot shows nothing at all.

```diff
- useTheme() // returned mode: "light" | "dark" | "auto"
+ useTheme() // returns  mode: "light" | "dark" | "system"
```

`system` is now written to `<html data-theme>` **verbatim** rather than resolved
to light/dark in JS, because `@botticelli/blokkit` resolves it in CSS with its own
`@media (prefers-color-scheme: dark)` branch. Writing a resolved value leaves that
branch dead and dark mode silently stops following the OS.

**Migration:** replace `"auto"` with `"system"`. No consumer imports
`@theblockbrain/bb-client-sdk/ui` today, so the practical cost is zero.

### 2. `encodePKCEState` / `decodePKCEState` are removed

The snapshot catches the symbols. It cannot catch that **`ms-outlook-addin` uses
both in production**, so its build breaks the moment it bumps.

They base64'd the PKCE verifier into the OAuth `state` parameter, putting it in
the authorize URL — and so in browser history, the `Referer` header, and Zitadel's
access logs (**CWE-200**). That makes an intercepted authorization code redeemable,
defeating the one thing PKCE exists for.

**Migration is a restructure, not a substitution.** The verifier used to cross into
the Office dialog; now it never leaves the taskpane:

```ts
// taskpane
const identity = createOfficeIdentityAdapter({ office: Office, redirectUri });
const result = await login(identity, { clientId });

// callback page, inside the dialog — do NOT redeem here
Office.context.ui.messageParent(window.location.href);
```

New `./adapters/office` subpath. Note the redirect URI must be **fragment-free** —
RFC 6749 §3.1.2 forbids a `#`, and a hash route hides the `?code=` inside the
fragment where the parser cannot see it.

### 3. `callAgenticStream` now throws where it returned quietly

Same signature, same name — only the behaviour moved.

A fail-fast tool-call, a server `data-error` frame, or an exhausted resume budget
now raise `AgenticStreamError` instead of ending the stream. Previously each was a
bare `break`, which returned the text accumulated so far as though the turn had
finished — so `useChatStream` committed a half-answer to the message cache as the
assistant's final reply.

**Migration:** handle the rejection. `MessageStream.final` rejects and the error
re-throws into `textDeltas`. The error carries `reason`, `partial`, and for a
server error `code` / `traceId` / `retryable`.

### 4. Both SSE parsers changed their parameter type

**The most invisible of the five** — the names are identical:

```diff
- parseBlockySseStream(body: ReadableStream<Uint8Array>)
- parseAgenticStream(body: ReadableStream<Uint8Array>)
+ parseBlockySseStream(chunks: AsyncIterable<string>)
+ parseAgenticStream(chunks: AsyncIterable<string>)
```

Both previously did their own `reader.read()` + `TextDecoder`, duplicating what
the transport already does. Taking decoded text instead removes their dependency
on `ReadableStream` entirely — which is what lets React Native feed XHR chunks and
Lit feed `EventSource` messages. Until now the parsers were the reason mobile
could not use `sendMessage` at all.

**Migration:** callers using `sendMessage` are unaffected. A caller invoking a
parser directly must pass an async iterable of strings.

### 5. `LoginOptions.orgId` added

Additive and non-breaking, but a new public option that appears in no diff, since
adding a field to an interface does not change any exported symbol name.

It appends `urn:zitadel:iam:org:id:<id>` **on top of** whatever scopes are in
effect. Use it instead of hand-building the URN, because
**`LoginOptions.scopes` replaces `AUTH_SCOPES` rather than extending it** — pass a
partial list and you silently drop `offline_access`, which means no refresh token
and a session that dies at first expiry with no visible cause.

```ts
login(identity, { clientId });                    // org from token claims
login(identity, { clientId, orgId: tenantId });   // login pinned to an org
```

---

## Breaking changes the snapshot does show

### Renamed

| Before | After |
| --- | --- |
| `Agent` | `AgentSwitch` |
| `AgentsResponse` | `AgentSwitchesResponse` |
| `Capability` | `CapabilitySwitch` |
| `CapabilitiesResponse` | `CapabilitySwitchesResponse` |
| `ApiResponse` | `MutationAckResponse` |

`./api` re-exports `./agentic` wholesale, so a bare `Agent` was genuinely ambiguous
between *the thing that executes* and *the admin toggle that reveals it*. These
types are the toggle.

### Moved

- **`./utils` → `./text`** for `extractJson`, `repairUnescapedQuotes`, `extractCode`.
  `./utils` now exports only `createLock`.
- **`subFromAccessToken`** moved from `./utils` to `./auth`, merged with the
  duplicate JWT decoder that had drifted from it.

### Removed

- **`./prompt` and `./actions` subpaths.** Chrome-only DOM automation;
  `actions/runner.ts` took `doc: Document = document`, a latent React Native
  import-time trap reachable from the root barrel.
- **`ThemeToggle`, `ThemeToggleProps`, `applyTheme`, `configureLogo`, `themeIcon`,
  `cycleTheme`, `ThemePref`** from `./ui`. `nextThemeMode` replaces `cycleTheme`.
  No toggle component ships: one styled in default Tailwind palette classes renders
  unstyled wherever blokkit's `tailwind-reset.css` sets `--color-*: initial`.

---

## Added

- **One transport for every call** (`./api` — `Transporter`, `createFetchTransport`).
  `grep 'fetch(' src/api src/auth` now returns only the transport itself, and a lint
  rule keeps it that way. Inject via `AuthContext.transport` for a runtime whose
  global `fetch` will not do — React Native's XHR streaming, b2b's proxy rewrite,
  or a recorded transport in tests.
- **Opt-in retry** on idempotent (GET) requests, with backoff. Off by default.
- **A 401-refresh hook** (`TransportConfig.onUnauthorized`) — refresh once and
  replay, never in a loop. Wrap your refresh in `createRefreshGuard`.
- **Real cancellation.** `SendMessageOptions.signal` / `AgenticCallOptions.signal`
  reach the transport, so `useChatStream().stop()` genuinely aborts rather than
  merely abandoning the response.
- **`BBHosts.auth`** — the Zitadel authority is a host like any other, so token
  calls get the same proxy rewrite, timeout and retry as everything else.
- **`./adapters/office`** — the Office dialog PKCE flow, shared by all four add-ins.
- **`./telemetry`** — the event taxonomy, vocabulary and consent gate.
- Three previously-missing agentic SSE frames: `data-tool-call-too-large`
  (suppresses auto-resume), `data-error`, `data-connect-integration`.

## Fixed

- **`getAvailableWebSearchProviders` hit a 404.** It called
  `/cortex/web-search/provider`; blocky mounts the router at `prefix="/websearch"`.
  Silent, and no test caught it because nothing asserted the URL.
- **`agents`, `capabilities` and `tenant-config` pointed at the wrong host** and
  forced the admin branch, 403-ing every normal user.
- **JWT claims with non-ASCII characters were mangled** — one of two decoders read
  `atob`'s binary string directly, so `"Müller"` decoded as `"MÃ¼ller"`.
- **One error shape.** Two `throwIfNotOk` implementations meant a non-2xx produced
  a differently-shaped `BBApiError` depending on which host you called.
