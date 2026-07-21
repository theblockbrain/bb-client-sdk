---
name: sdk-endpoint
description: "Use when adding or changing a ./api endpoint module (bots, conversations, messages, agents, capabilities, tenant, websearch, transcribe, notes, …) or its ./react query/mutation hooks in bb-client-sdk."
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# sdk-endpoint — add or change a `./api` endpoint (and its `./react` hooks)

> **Inherits from**: `/sdk` — see that skill for the adapter matrix, invariants, and verification loop. This sub-skill does not restate them; it links.
>
> Base code style is the org **Code Cleanup & Refactoring** standard (import order, no `any`, early returns, error handling, verification checklist). Follow it; don't restate it.

**Dual audience.** SDK maintainers author these modules. Adapter (consumer) developers read this to understand the contract they call and why a change might reach them. A change here fans out to **every** surface in `../sdk/references/adapters.md` — treat that as the blast radius.

Follow these phases **exactly, in order**. Do not skip Phase 6.

---

## Phase 1 — Pattern-match an existing module (do not freelance)

Read a sibling before you write. The `./api` modules share one shape; copy it.

- **`fetch`-based, blocky/cortex host** → read `src/api/bots.ts` + `src/api/headers.ts`.
- **`fetch`-based, integrations host (feature switches / admin config)** → read `src/api/agents.ts` + `src/api/_auth-headers.ts`.
- **cross-tenant admin (`?orgId=`)** → the `buildUrl` helper in `src/api/agents.ts`.
- **multipart upload** → `src/api/transcribe.ts` (do NOT set `Content-Type` by hand).
- **paginated list** → `getMessageList` in `src/api/messages.ts`.

Every new function MUST, exactly like the siblings:

1. Take `ctx: AuthContext` (from `src/settings/auth-mode.ts`) as its first parameter. Never take a bare `token`/`baseUrl` — the whole context carries mode, orgId, and userId together.
2. Resolve the base URL through `normalizeUrl(ctx.baseUrl)` (`src/api/url.ts`) — never concatenate raw.
3. Build auth headers with the **correct helper for the host** (see table). Never hand-roll `Authorization` / `x-zitadel-org-id`.
4. **Throw `BBApiError` on every non-2xx** (`src/api/errors.ts`) with `{ endpoint, responseBody }`. Never swallow, never return `null` on an HTTP error, never throw a bare `Error` for a non-2xx.

### Header helper — pick by backend host

| Host / modules | Helper | `x-zitadel-org-id` behavior |
|---|---|---|
| blocky/cortex (`bots`, `conversations`, `messages`, `tenant`, `transcribe`) | `authHeaders(ctx.token, ctx.orgId)` — `src/api/headers.ts` | Sent whenever `orgId` is set (both modes) |
| integrations (`agents`, `capabilities`, `tenant-config`) | `bbApiAuthHeaders(ctx)` + `throwIfNotOk(res, endpoint)` — `src/api/_auth-headers.ts` | Sent **only** in `oauth` mode — the integrations host 500s on the header in `api-key` mode |

Getting this wrong is a live-500 bug. If you are unsure which host a new module hits, match the sibling that calls the same backend service — do not guess. `authHeaders` deliberately omits `Content-Type`: add `"Content-Type": "application/json"` yourself for JSON bodies; for `FormData` leave it unset so the runtime derives the multipart boundary (see `transcribe.ts` and the `headers.ts` doc comment).

The non-2xx block is boilerplate you copy verbatim (bots.ts lines 55–66); on the integrations host, `throwIfNotOk` encapsulates it.

---

## Phase 2 — Types + the public-API contract

- Export only the types the surfaces actually need (`interface`/`type` for request options, response body, and any enum union). No `any`; model the raw envelope with a local `Raw*` interface and map it (see `RawBot` → `Bot` in `bots.ts`, `RawTenant` in `tenant.ts`). Backends wrap payloads inconsistently (`{ body }`, `{ content }`, `{ data }`, flat array) — normalize defensively like the siblings do.
- Re-export new public symbols from `src/api/index.ts` (values and `export type` separately, alphabetized — match the existing file).
- **Any added/renamed/removed public export changes the public-API snapshot.** `src/public-api.contract.test.ts` snapshots the exported names (values AND types) of all entry points (11 today; 12 once `./analytics` lands); an undeclared change fails CI.
  - Additive export → snapshot grows → intentional **minor**.
  - Rename/removal → this is a **breaking** fan-out change. Semver + consumer range-pinning means it breaks surfaces silently (the Outlook add-in pinned a stale `^0.7.3` — the cautionary tale). Requires an intentional bump and a canary pass in a real consumer before `latest` (see `../sdk/references/cross-adapter-safety.md`).
  - To land an intentional change: update the snapshot with `vitest -u` **in the same PR** and call it out in the description.

---

## Phase 3 — The React layer (only if adding a hook)

React hooks are OPTIONAL. Add one only when a surface needs `./react`; the framework-agnostic `./api` function is the real deliverable and must stand alone (Slack/Node and Lit call it directly — invariant A). Keep `react` and `@tanstack/react-query` as **externalized peers**: they are imported **only** under `src/react/**`, never from `src/api/**`.

Read the sibling first: `src/react/queries.ts` (reads), `src/react/mutations.ts` (writes), `src/react/keys.ts` (`bbKeys`).

**Reads (`queries.ts`):**
- Every read gets a `queryOptions`/`infiniteQueryOptions` **factory** that takes `getCtx: () => AuthContext` (a getter, not a token — so the freshest token is used at fetch time) plus a matching `use…()` hook that pulls `getAuthContext`/`orgId` from `useBBContext()`.
- Key it through `bbKeys(orgId)` — every key is rooted at `['bb', orgId]`, partitioning the cache by tenant. Do not build ad-hoc key arrays.
- Guard on the id with `enabled: !!id` when the arg can be empty (see `useBotDetail`, `useConversationDetail`).
- Cross-tenant read → scope the key under `targetOrgId ?? homeOrgId`, exactly like `agentsQueryOptions`/`capabilitiesQueryOptions`. Scoping under the home org would collide an admin's cross-tenant view with their own data.
- Paginated → `useInfiniteQuery` with `initialPageParam` (v5 requires it explicitly) and a `getNextPageParam` that returns `undefined` when done. Copy the loaded-vs-total math in `messagesInfiniteOptions`. Consider `placeholderData: keepPreviousData` for filter transitions.

**Writes (`mutations.ts`) — get invalidation right:**
- Simple write → `onSuccess` invalidates the affected `bbKeys` prefix (a coarse key prefix-matches every finer key beneath it, so invalidating `messages.forConvo(id)` clears every paginated/keyword variant at once).
- Optimistic write → the full `cancel → snapshot → optimistic set → rollback in onError → reconcile in onSettled` cycle. Copy `useSetAgentActive`. `useChatStream.send` models the optimistic-then-rollback path for the streaming case.
- **Agent-swap rule (STATUS.md):** there is no `setConversationAgent` endpoint today — a conversation's agent is fixed at `createConversation`. If you add that endpoint, its hook's `onSuccess` MUST call `invalidateConvoDetailCache(convoId)` (`src/api/messages.ts`) to purge the hidden module-level routing cache, or `sendMessage` will keep routing on the stale agent. `useDeleteConversation` already models this dual purge (React Query cache **and** the hidden cache).

If you add a hook to `src/react/index.ts`, that is also a public-export change → re-run Phase 2's contract test.

---

## Phase 4 — Multi-tenant + auth correctness (security-critical)

This is invariant D and a zero-tolerance isolation boundary. See `../sdk/references/adapters.md` for the auth-flow-per-surface matrix.

- **`orgId` vs `targetOrgId`.** `AuthContext.orgId` is the caller's **HOME** org and drives the `x-zitadel-org-id` header (identity). To operate on another tenant (admin), pass a separate `targetOrgId` that becomes the `?orgId=` query param — see `buildUrl` in `agents.ts`. **Never** put the target tenant's org into `AuthContext.orgId`. Cross-tenant leakage is a defect, not a bug.
- **Agentic needs a userId.** If the endpoint touches the Agentic path, the `sub` must resolve via `ctx.userId ?? subFromAccessToken(ctx.token)` (see `sendMessage`, messages.ts lines 123–131). `api-key` mode has no `sub` → Agentic is unavailable → hard error, never a silent wrong-user call.
- **OAuth ignores `settings.bbUrl`.** In `oauth` mode the base URL is pinned to `OAUTH_BACKEND_URL` (audience pinning); don't add a knob that lets a caller point an OAuth token at an arbitrary host.

---

## Phase 5 — Telemetry (the release-gate seam)

Invariant E: nothing ships without product analytics **and** health telemetry. The SDK's job is the seam, wired per surface.

- The `AnalyticsAdapter` seam is **planned** (**WS9** — not yet on `main`); once it lands, emit via `trackEvent(...)` / `trackApiError(err)` from `@theblockbrain/bb-client-sdk/analytics` (the surface registers the adapter). `api_error` is **not auto-emitted by the core** — it is wired incrementally per call site — so your obligation in this phase is still to keep the endpoint *instrumentable*:
  - Every non-2xx throws `BBApiError` carrying **`statusCode` and `endpoint`** (Phase 1) — that is exactly the payload `trackApiError(err)` forwards to the `api_error{ statusCode, endpoint }` event (call it in a catch block, then re-throw). A bare `Error` or a swallowed failure is un-instrumentable and blocks the gate.
  - **Never** log the token or put `responseBody` into a thrown `message` — `responseBody` may echo secrets. `trackApiError` forwards only `statusCode` + `endpoint` (never `responseBody`); scrub before any surface forwards it to Sentry.
- If your endpoint is a new streamed turn, note the taxonomy it must emit (`stream_start` / `stream_first_token` / `stream_complete` / `stream_dropped`), wired via `trackEvent(...)`, so the surface wiring is unambiguous.
- WS9 has landed, so this phase is now "call `trackApiError(err)` (or `trackEvent(...)`) at the throw/catch site" where the endpoint or surface wires it; the standing checklist item is still that a surface can derive the standard events from what you throw.

---

## Phase 6 — Verify (full loop + contract + cross-adapter)

Run the real gate, in this order (mirrors `ci.yml`). All must pass:

```bash
npm run lint          # biome check + eslint src (type-aware)
npm run typecheck     # tsc --noEmit over all of src
npm test              # vitest run — includes the public-API contract test
npm run build         # tsup + dts + theme-base.css
npm run check:package # publint + attw --pack . --profile esm-only
```

Then, specifically for this change:

- [ ] **Contract test** passed, or you ran `vitest -u` and the snapshot diff is intentional and reviewed (Phase 2).
- [ ] **Add tests for new behavior** — the STATUS.md gaps are explicit: pagination (`getNextPageParam`/`initialPageParam`), optimistic paths, and conditional invalidation are the things that break silently. A hook that only typechecks is not covered.
- [ ] **`check:package` clean** — confirms the export map still tree-shakes and `./api` + `./auth` carry **zero React** in their graph (invariant A). If you accidentally imported React into the core, attw/publint or the graph will show it.
- [ ] **Cross-adapter pass** — the endpoint is `fetch`-based, so it must work under **Node (Slack) and RN (mobile)** transports, not just the browser. Walk `../sdk/references/cross-adapter-safety.md` and confirm no browser-only assumption slipped in:
  - No direct `window`/`document`/`localStorage`/`EventSource` — storage always via `StorageAdapter`.
  - Global `crypto.randomUUID()` (used in `messages.ts`) is fine in browsers + Node ≥20, but **RN needs a polyfill** — flag it if your endpoint adds a new `crypto` call.
  - `ReadableStream`/SSE streaming is **unreliable in RN** (the transport-seam blocker, WS2/WS7). A streamed endpoint must degrade or route through the seam, not assume `res.body`.
  - `FormData`/`Blob` semantics differ across RN/Node — verify multipart if you added it.

Do **not** cut/tag a release from this change assuming the release re-runs the gate: `publish.yml` runs **only** typecheck + build (KNOWN GAP — see `/sdk`). `ci.yml` on `main` is the safety net, so the change must be green there before release. A public-surface change additionally needs a canary in a real consumer (Outlook) **before** it reaches the `latest` tag.
