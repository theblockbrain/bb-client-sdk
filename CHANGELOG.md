# Changelog

## Unreleased — 0.20.0: one telemetry vocabulary, and the second sink

**Not yet cut.** `package.json` still declares `0.19.0`; the bump, the tag and the
Outlook canary belong to the release commit, not to this one. The note is written
here now because the contract snapshot has already moved, and a snapshot diff with
no migration note is a review blocker
(`.claude/skills/sdk/references/release-and-versioning.md` §1).

**It is a minor, and the minor is this package's major.** Renaming an event is the
`MAJOR` row of that table ("Change an event-taxonomy name, header, or wire shape a
surface depends on"), and because consumers pin `^0.MINOR.PATCH` — which npm
resolves as `<0.M+1.0` — a breaking change must land as a **minor** with a
migration note and never as a patch. `0.19.1` would push this into every
`^0.19.0` consumer on their next install with nobody choosing it.

### ⚠️ Breaking: the event taxonomy has ONE vocabulary now

`AnalyticsEventMap` was a second, independently-declared event map that overlapped
`CoreEventMap` from `./telemetry` and disagreed with it on every name and property
spelling. It is now an alias:

```ts
export type AnalyticsEventMap = CoreEventMap; // @deprecated — import CoreEventMap
```

`CoreEventMap` won on three counts: its property names are legal Prometheus label
names (`status_code`, `ttft_ms`, `latency_ms` — `statusCode` reads as foreign in
every PromQL query written against it), it carries `route` (shared with the
backend's `llmActionTypeSchema`) rather than an SDK-private
`backend: "blocky" | "agentic"`, and `CORE_EVENT_NAMES` is proved exhaustive
against it at compile time.

**The alias keeps the NAME resolving, not the SHAPE.** A consumer that only writes
`track<K extends AnalyticsEventName>(...)` compiles untouched. A consumer that
switches on an event name, or emits one, does not — and a dashboard keyed on the
old names goes quiet without any compile error at all. That second failure is the
one to plan for.

| Was | Now | Property changes |
| --- | --- | --- |
| `auth_started` | `sign_in_started` | `mode: "oauth" \| "api-key"` → `method: SignInMethod` (`password \| sso \| oidc \| api_key`) |
| `auth_success` | `sign_in_completed` | `latencyMs` → `latency_ms`; adds `owner_permission?` |
| `auth_failed` | `sign_in_failed` | adds `error_code?`; `stage` unchanged |
| `token_refresh{ ok }` | **splits** into `session_token_refreshed` / `session_token_refresh_failed` | a boolean discriminator is not a funnel step in Mixpanel |
| `message_send` | `message_sent` | `conversationId` → `conversation_id`; `message_id` and `route` now REQUIRED; `streaming` dropped |
| `stream_start` | `stream_started` | `backend?` → `route`; adds `request_id?`, `conversation_id?` |
| `stream_first_token` | `message_first_token` | `latencyMs?` → `ttft_ms` (required) |
| `stream_complete` | `message_completed` | `durationMs?` → `duration_ms?`; adds required `outcome` |
| `stream_dropped` | `stream_dropped` | `backend?` → `route`; `reason` is now the closed `StreamDropReason` |
| `stream_reconnect` | `stream_reconnect` | `backend?` → `route` |
| `api_error` | `api_error` | **`statusCode` → `status_code`** |

`LEGACY_EVENT_RENAMES` in `./telemetry` is the machine-readable form of this table
and is kept deliberately: a surface still emitting the old names needs a documented
target, and losing an entry strands its dashboards.

**To migrate a surface:** rename at your call sites and in your Mixpanel/Grafana
queries together. There is no translation layer in the adapter, by design — two
vocabularies live on the wire is exactly the state this removes.

### ⚠️ Behaviour change: `stripDeniedProperties` strips more

`DENIED_PROPERTY_KEYS` gained the OIDC/Zitadel claim spellings — `mail`,
`user_email`, `username`, `preferred_username`, `given_name`, `family_name` — and
`message`.

This is a **security fix, and it is why the entry is here rather than under Added.**
Extracting the Mixpanel adapter's private denylist into the shared
`./analytics/scrub` split one list into two — credentials in `SECRET_DENYLIST`, PII
in `DENIED_PROPERTY_KEYS` — and six names fell through the gap between them, so
they reached Mixpanel and, once the Faro leaf landed, a second sink as well. Those
six are precisely the names an ID-token claims object uses, which is the bag the
guard exists to catch.

Matching folds case and separators, so one entry covers `userEmail`, `user_email`
and `User_Email` alike. A surface that was (incorrectly) relying on one of these
reaching Mixpanel will see it dropped.

### Added

- **`./analytics/faro`** — `createFaroAdapter`, typed structurally against
  `@grafana/faro-web-sdk` so the SDK still declares no analytics dependency. Faro
  answers "is it slow or broken", Mixpanel answers "are people using it"; the
  release gate wants both. Browser surfaces only — Faro has no React Native
  support. Exports `FaroLike`, `FaroUser`, `FaroAdapterConfig`.
- **`createCompositeAdapter`** (from `./analytics`, also on the root barrel) —
  `setAnalyticsAdapter` takes exactly one adapter, and the gate wants two. Each
  child call is guarded individually, so one throwing sink cannot silence the rest;
  `identify`/`group`/`flush` are declared only when a child implements them, which
  is how a multi-tenant Node process keeps omitting the process-wide binding.
  ⚠️ Composing a child that HAS `identify` with one that deliberately omits it
  re-arms the process-wide binding — for Slack, compose only sinks that omit it.
- **`npm run verify:published`** (`scripts/verify-published.mjs`) — asks whether a
  published tarball actually contains the surface its source claimed, by reading
  the contract snapshot **at the release tag** and searching the shipped `dist/`.
  Exit `1` means the artifact is wrong; `2` means the check could not run. See the
  header for what a pass does and does not prove.

### Not in this change

The call-site instrumentation — `message_*` and `stream_*` from
`src/api/messages.ts` / `stream-result.ts`, `session_token_*` from
`refresh-singleton.ts`, and `api_error` from `_send.ts` — is deliberately held
back. It has open correctness work (a `sendMessage` failure emits no terminal
funnel event; `dropReason` reads `statusCode` instead of `BBApiError.kind` and so
reports `unknown` for every transport-level drop) and no tests observe any emitted
event. Shipping the vocabulary and the sinks first means a surface can adopt both
without also adopting that.

---

## 0.19.0 — the client-executed tool relay, and the Office adopter gaps

Everything here landed on `main` **after** the commit `v0.18.0` was cut from, so
none of it is in the published `0.18.0`. Purely additive: three new exports from
PDEV-7369, twenty-odd from PDEV-8061 including a new `./dev/sdk-link` entry point,
and the relay surface below. Nothing renamed, nothing removed, no behaviour change
to a stable export — so a consumer on `^0.18.0` compiles unchanged against this.

It is a **minor** and not a patch even though it looks like catch-up. New exports
and new optional parameters are a minor by the table in
`.claude/skills/sdk/references/release-and-versioning.md`, and the contract
snapshot moved in all three commits, which is that table's own tripwire. Shipping
it as `0.18.1` would push it into every `^0.18.0` consumer on their next install
with nobody choosing the upgrade — and Outlook is mid-migration (PDEV-6809).

Consumers pin `^0.MINOR`, so this does **not** reach a surface until its
`package.json` moves off `^0.18.0`. That is the point.

### Why 0.18.0 shipped without the relay

Worth recording, because the notes for this content were briefly folded into the
`0.18.0` section on the belief that no `0.18.0` existed.

The `v0.18.0` tag was pushed at 16:59 on 2026-08-06, pointing at the
dependency-floor merge. `publish.yml` fires on a `v*` tag push, so it published
from **that** commit. The relay merged at 19:39 the same evening — two hours and
forty minutes later, and therefore not in the artifact. A registry version is
immutable, so `0.18.0` cannot be re-cut to include it; this is why the number is
`0.19.0`.

The check that settles it in one line, and which belongs in the release routine
after every publish:

```bash
grep -rl externalTools node_modules/@theblockbrain/bb-client-sdk/dist
```

Empty output against a version whose notes promise the relay means the tag
predates it. Run against published `0.18.0` it is empty — that is how this was
found, after a consumer declared `^0.18.0`, called `externalTools`, and had the
field dropped from the request body with no error.

---

## Added

### Client-executed tools, relayed through the agentic stream

The half of the agent loop only the host can run. `AgenticCallOptions.externalTools`
declares tools to the model; when it calls one the run suspends server-side,
`executeExternalTool` runs it locally, and the SDK resumes the run with the result.
That is what lets an agent insert at the Word cursor or read the open mail item —
the model plans, the surface acts, and neither needs the other's runtime.

Dispatch is **by name**, and only when the caller supplied both halves. A relayed
call and an ask-user-question arrive as the same frame type, distinguishable only by
the tool name, so answering one with the other's shape would hand the model an empty
answers map where it expected its tool's output. Declaring tools with no executor
falls back to the approval resolver rather than calling `undefined` mid-turn.

Two failure modes are handled rather than left to the caller:

- **`externalTools` is re-sent on every resume**, not just the initial request. The
  server rebuilds the relay tool per request, so dropping it mid-turn strands the
  suspended run — which is why every request body is built from one `baseBody()`
  rather than assembled by hand at each resume site.
- **A throwing tool resumes with `{ error }`** instead of ending the turn. The run
  is suspended server-side; throwing abandons it and costs the user a whole turn
  because one tool failed. Telling the model lets it retry another way — the same
  courtesy the server extends via `tool-output-error` for its own tools.

`maxExternalToolCalls` (default 32) is a **separate** budget from `maxAutoResumes`,
since a legitimate multi-step edit consumes relay calls at a rate a resume cap was
never sized for.

New on `./agentic` (and `./api`, which re-exports it): `ExternalToolDef`,
`ExternalToolExecutor`, `ExternalToolCall`, `AgenticExternalToolResumeData`,
`JsonValue`, `ToolInputAvailableFrame` and `isToolInputAvailableFrame` — the
`tool-input-available` frame is what carries the arguments, keyed by `toolCallId`,
so the executor receives real `input` instead of re-deriving it.

**Server-side allow-list.** Relay is honoured only for agents on the server's list
(today the WebComponent Agent and the Word Agent). For any other agent the tools are
shown to the model but its calls are never relayed, so no suspend arrives and the
turn stalls on the model's side — a server-side fact the SDK cannot detect or fix.

### Closing the gaps the Word add-in worked around (PDEV-7369)

Each item is something `packages/word-addin` hit while migrating onto 0.18.0 and
either worked around locally or found the SDK weaker than the code it replaced.
Filed here so the next Office adopter (PowerPoint, Excel) does not repeat it.

- **`extractJson` gets two-token lookahead and truncation recovery.**
  `repairUnescapedQuotes` decided a string terminator from ONE token of lookahead,
  which a stray quote inside prose also satisfies: a German translation containing
  `„node", was die Map ignoriert` lost string parity for the rest of the document,
  and keywords matched by first letter read `nein` as the start of `null`. Replaced
  by the add-in's algorithm — seven inputs that returned `null` now recover.
  PDEV-7477 is the incident, where a whole-document translation produced ~90
  correct edits and every one was discarded. New `closeUnbalancedJson` recovers the
  complete elements from a response cut off at a token ceiling, and bails when the
  fragment ends inside an unterminated string, because guessing there corrupts
  content rather than recovering it. The module had no test file at all, which is
  how the weak lookahead survived; it now has 41.
- **`./adapters/office` accepts the real `Office` object.** `@types/office-js`
  declares `AsyncResultStatus` and `EventType` as implicit NUMERIC enums while the
  runtime populates them with strings, so `typeof Office` was not assignable to
  `OfficeGlobal` and the add-in needed a 50-line bridge to pass it in. Widened to an
  `OfficeToken` union with values passed through untransformed, since every token is
  either compared against another from the same source or handed straight back to
  Office. Adds `onOpened`, fired once the dialog is really on screen: Microsoft 365
  shows its own permission prompt first, and a surface that raises an overlay on
  click covers the button the user has to press (PDEV-3804).
- **`orgId` works on the browser auth path.** `withOrgScope` was private to
  `login.ts`, so only the adapter-driven path could pin an organization and
  `BrowserRedirectOptions` had none. The add-in shipped exactly that asymmetry — the
  dialog path passed `orgId`, the browser fallback did not — and nothing fails when
  the scope is missing: Zitadel resolves the user's home org instead, so a
  multi-org developer authenticated into the wrong tenant with no error and no
  telemetry to find it by. Extracted to `auth/org-scope.ts`, used by both, with a
  test asserting the two paths produce byte-identical `scope` parameters.
  `completeBrowserLogin` still ignores `orgId`: a code exchange carries no scope.
- **`useTheme` gains a setter and a host theme.** It returned
  `[theme, mode, cycleTheme]` with no setter, so a surface with three explicit
  controls could not be built on it. `setMode` is appended as a FOURTH tuple
  element, leaving existing three-element destructuring untouched. `hostTheme`
  closes a JS-versus-CSS disagreement: resolution used `prefers-color-scheme` only,
  but an Office task pane follows Word's own theme, so a consumer branching on
  `theme` to pick a light or dark asset chose the wrong one for the background it
  sat on. Mirrored onto `data-host-theme` and deliberately NOT folded into
  `data-theme`, which keeps carrying `mode` verbatim, `system` included, because
  blokkit resolves `system` in CSS through its own media query and writing a
  resolved value there makes that branch dead code (PDEV-7000).
- **Fixed a stale warning that cost an adopter the whole transport seam.** The
  header read "NOT WIRED YET, ON PURPOSE … deliberately absent from
  `src/api/index.ts`" while `index.ts` sixty lines in says "public since
  PDEV-7337/7338". It stayed wrong through two releases, and an adopter reading it
  reasonably concluded the transport was off limits and rebuilt timeouts, retries
  and 401 replay by hand.

New exports: `closeUnbalancedJson` (`.` and `./text`), `OfficeToken`
(`./adapters/office`), `UseThemeOptions` (`./ui/react`).

### Agentic finish metadata, and five more adopter gaps (PDEV-8061)

- **The finish frame's metadata is no longer dropped.** The terminal finish part
  carries the answer's citations and nothing else does, and it fell through to
  `UnknownFrame`. A consumer therefore received an answer full of `[1]` markers
  with nothing to resolve them against — which is why those markers are inert in
  the Word add-in while the web app renders them as links. Adds `FinishFrame`,
  `isFinishFrame`, `AgenticCitation`, `AgenticStreamMetadata` and an `onMetadata`
  callback. A callback rather than a widened yield type, because
  `callAgenticStream` still yields `AsyncIterable<string>` and changing that would
  break every caller. It fires at most once per TURN rather than once per resume
  request, and stays silent when the server sends no `messageMetadata`, so a caller
  cannot be tricked into clearing state an earlier turn filled.
- **The `externalTools` wire guard** (`assertRelayOnTheWire`, `bodyDeclaresRelay`,
  `RelayNotOnTheWireError`, `isRelayNotOnTheWireError`). It observes the serialized
  request body, so it catches both ways a relay silently fails to reach the server:
  a build that predates the relay, and a caller that assembled a body and dropped
  the field. Either one leaves the model holding tools it can never call, with no
  error and no 4xx.
- **The Office host theme reader** — `readOfficeHostTheme`,
  `watchOfficeHostTheme`, `OfficeThemeColors`, `OfficeThemeHost`,
  `WatchOfficeHostThemeConfig`, `OFFICE_HOST_THEME_POLL_MS`.
- **A new `./dev/sdk-link` entry point**, the dev tool for testing an adopter
  against an unreleased checkout without touching its `package.json` or lockfile.
  It is the supported answer to the situation this release exists to fix.
- **File-icon helpers** (`getFileIconName`, `EXTENSION_TO_FILE_ICON`,
  `FILE_ICON_FALLBACK`) and the **stream coalescer** (`createStreamCoalescer`,
  `StreamCoalescer`, `StreamCoalescerConfig`), both lifted out of the add-in.

---

## 0.18.0 — the consolidation baseline

The first release since `v0.17.0` (2026-06-23), and the baseline every adapter
migration builds on. It carries the whole of **WS2** (one transport for every
call), the **rename cluster**, a **React-free root barrel**, the host ports
(crypto, capabilities, flags), the `./i18n` and `./media` layers, the shared
Office add-in logic, and a set of security fixes.

Breaking changes are batched into this single bump on purpose. Every one of them
is breaking, and three repos install this package — spreading them across several
minors would make consumers pay the migration tax repeatedly.

**This section describes the published `0.18.0` artifact and nothing more.** It
briefly said the opposite: that an in-flight `v0.18.0` tag never published, so
content drafted under a `0.19.0` heading could be folded back in here. That was
wrong. The tag published from the commit it pointed at, and the registry has been
serving it since — `latest: 0.18.0`, immutable. Everything drafted after that
commit is in `0.19.0` above, where it was originally filed.

**Read the two breaking-change sections first.** Consumers pin `^0.MINOR`, so
this bump does not reach a surface until someone changes its `package.json` —
and when they do, everything below arrives at once.

---

## ⚠️ Read this first: six breaking changes CI cannot see

`src/public-api.contract.test.ts` compares **exported symbol names**. The six
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

### 6. `launchOAuthFlow` rejects with a different error

Same signature and the same failure conditions, but the rejection is now an
`OfficeDialogError` and a cancelled dialog no longer says "cancelled" — so a
surface matching on the message text reads a cancelled sign-in as a hard error.
Full detail, and the one-line fix, under
[the Office add-in section](#the-office-add-in-surface-logic-moves-into-the-sdk).

---

## Breaking changes the snapshot does show

### `useTheme` moved to `./ui/react`

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
`./settings` is now per-resource and framework-agnostic, and **every `./react` query
reads it**: `provider.tsx` takes `BB_CACHE_DEFAULT` for the client default, and each
`queryOptions` factory takes its own resource's `staleMs` and `retainMs`.

That last part is the whole point, and it is worth stating because the first cut of this
change missed it: the policy table existed while only `messages` consumed it, so the
30-minute entries below were dead data and those resources kept refetching on the
5-minute default. A policy no caller reads is documentation, not policy.

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
`{ key, title, detail, retryable }` and deliberately ignores the response body and the
error message, since server text can echo a submitted grant and this output is
rendered. The `key` is a `BBMessageKey`, so the English `title`/`detail` are defaults
rather than the only option.

`isRetryableStatus(status)` is now the single source for "is this worth retrying", and
all three consumers read it: `describeHttpStatus` (so `isRetryableBBError` and any
surface's error UI agree), `bbShouldRetryQuery` in the query client, and the transport's
retry loop — which previously kept its own `429 || 5xx` copy (PDEV-7341). They agreed on
every status `>= 400`, but by coincidence rather than by construction.

The predicate is deliberately **status-only and closed over `< 400`**. The transport
evaluates it against *every* response, including 2xx, so a permissive default would make
it discard successful responses and retry them until the attempt budget ran out. The
`kind` cases (`network`/`timeout` retryable, `aborted`/`parse` not) stay in
`describeBBApiError`, since a status cannot express them.

`503` gets no special case. It was documented as "capability not configured", but
that meaning has no source: Botticelli emits 503 **nowhere** (0 occurrences across
`packages/`, any language or config), no consumer branches on it, and the claim
entered as a comment in a README example. With no application path emitting it, the
realistic source is infrastructure mid-rollout — transient, and retryable per RFC
9110. Removed from the README and the /sdk skill.

### The Office add-in surface logic moves into the SDK

Four pieces that both Office add-ins had written independently, and that Wave 1
(Outlook) and Wave 2 (Word) would otherwise carry across the migration unchanged.
Each one is here because a *second* surface had already reproduced it, not in
anticipation of one that might.

**`openOfficeDialog` — the dialog courier, on `./adapters/office`.** The mechanics
that `createOfficeIdentityAdapter` owned privately (open, settle exactly once, map
code 12006 to a cancellation, close exactly once) are now a generic function over a
caller-supplied `parse`. `ms-outlook-addin`'s dictation popup had grown the same
~60 lines around a JSON envelope instead of a redirect URL; PowerPoint and Excel
would have been third and fourth. `createOfficeIdentityAdapter` now calls it, and
the OAuth-specific validation — absolute URL, no fragment-routed callback — lives in
its `parse`.

**Cancellation is a discriminant, not a message.** `OfficeDialogError` carries
`reason: "open-failed" | "cancelled" | "host-error" | "bad-message"` plus Office's
numeric `code`, with `isOfficeDialogCancelled(err)` for the one branch every surface
needs. This replaces text-matching: `ms-outlook-addin` had `/cancelled/i.test(msg)`
in `Login.tsx` and a separate `msg === "cancelled"` sentinel for dictation, and both
stop working the moment the message is reworded — which is exactly what wiring up
L12 does.

> ⚠️ **`launchOAuthFlow` rejects differently.** Same signature, same failure
> conditions, but the error is now an `OfficeDialogError` and the cancellation
> message is `"The dialog was closed."` — it no longer contains the word
> "cancelled". A surface matching on the text sees a cancelled sign-in as a hard
> error. The snapshot cannot catch this: the export name is unchanged.
>
> ```diff
> -if (/cancelled/i.test(err.message)) return;      // silently breaks
> +if (isOfficeDialogCancelled(err)) return;
> ```

**`createOfficeStorageAdapter` — the backend priority, with the reason attached.**
`Office.context.roamingSettings` is not a viable primary store: `saveAsync`
round-trips to the mailbox server and returns 500 for *sideloaded* add-ins on the
`outlook.cloud.microsoft` backend. The write reports success, nothing persists, and
the symptom is a user signing in on every open — with no error near the cause. So
the order is local Web Storage (source of truth, synchronous), `OfficeRuntime.storage`
(mirrored to when present), and `roamingSettings` **read once as a migration source
and never written**. Reads are synchronous (`SyncStorageAdapter`), so `warm(key)`
must be awaited during boot inside `Office.onReady` — skipping it is not a cache miss
that self-corrects, because a zustand store hydrating from an empty cache concludes
the user is logged out and then persists that conclusion.

**New `./media` subpath — the capture half of dictation.** `transcribeAudio` has
taken a `Blob` since v0.14 and stayed silent about producing one, so three surfaces
worked it out alone: `ms-outlook-addin` twice (task pane and dictation popup,
byte-identical) and `ms-word-addin` once inside a 323-line `useAudioRecorder`.
`pickAudioMimeType`, `extensionForAudioMimeType`, `audioFilenameFor`,
`formatRecordingTime` and `describeMediaCaptureError` are the decisions all three
made identically. The recorder **state machine is deliberately not here** — Outlook
drives a five-state task-pane button, Word drives a volume analyser, they disagree,
and neither is more right.

No DOM types cross the boundary: `MediaRecorder`, `MediaStream` and `DOMException`
are `dom`-lib only, so support is passed in as a predicate
(`MediaRecorder.isTypeSupported.bind(MediaRecorder)` — the bind matters) and errors
are inspected structurally. `instanceof DOMException` would also be wrong in an
Office add-in, where `getUserMedia` rejections cross realms.

**`plainTextToHtml` + `PLAIN_TEXT_HTML_TAGS` on `./text`.** Not a markdown renderer
and not a substitute for one — the opposite contract. The email and document surfaces
prompt for *no* markdown because Outlook and Word bodies are not markdown targets,
the model emits `- item` out of habit anyway, and inserting that verbatim ships
literal `- ` characters in the sent mail. Real `<ul>`/`<ol>`, everything else escaped
and joined with `<br>`. Shared because `ms-outlook-addin`'s `plainTextToHtml` and
`ms-word-addin`'s `chatContentToHtml`/`ensureHtmlBlocks` had converged on it.
`PLAIN_TEXT_HTML_TAGS` is exported so a caller's sanitiser allow-list cannot drift
from what the function emits — Outlook's DOMPurify config listed the tags by hand,
and a new one here would have been silently stripped. **Escaping is not sanitising**:
every text node is escaped, but the caller still hands the result to a host API that
renders it, so keep the sanitiser.

**Three new `BBMessageKey`s** — `media.permissionDenied`, `media.deviceNotFound`,
`media.captureFailed`. A surface asserting its catalogue is complete against
`BB_MESSAGE_KEYS` must add them. They live in the SDK's key space because the
*condition* is the SDK's to detect: two surfaces had already written the same
three-branch `DOMException.name` ladder.

---

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

---

## The gate that would have caught all of this

`npm run check:cleanroom` gained a second phase that installs the tarball with
**no** React and imports every entry point. It also asserts `./react` and
`./ui/react` *do* fail there — if they ever stop failing, React has stopped being
a real peer and the split has lost its meaning.
