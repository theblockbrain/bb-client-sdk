# `./react` layer — status & known gaps

**Branch:** `feat/react-query-layer` · **Added:** 2026-07-13 · **Owner:** Chiheb Hmida
**What this is:** the new `@theblockbrain/bb-client-sdk/react` React Query data layer
(provider + `bbKeys` + query/mutation hooks + `useChatStream`), built test-first.
Design rationale lives in `~/Documents/Apps-Domain-SDK-Thickening-Report.md` (§3).

## Verified (as of this commit)

```
Tests       12 passed (5 files)   npm test          (vitest, scoped to src/react/**)
Typecheck   clean                 npm run typecheck  (tsc --noEmit over whole src)
Build       success               npm run build      (tsup → dist/react/index.{js,d.ts})
Peers       externalized          react / @tanstack/react-query are NOT bundled
```

Run locally: `cd ~/Documents/Glassbox/bb-client-sdk && npm test`
(npm is under the nvm bin — `~/.nvm/versions/node/v24.14.1/bin`; the `proto` shim does not expose npm.)

## Honest gaps — deliberate, for the next pass

1. **Test coverage is representative, not exhaustive.** Directly unit-tested behaviors:
   `bbKeys` scoping (`keys.test.ts`), the retry predicate (`provider.test.ts`), query
   wiring via `useBots` (`queries.test.tsx`), optimistic rollback + the hidden-cache
   purge on delete (`mutations.test.tsx`), and `useChatStream` cache-commit
   (`use-chat-stream.test.tsx`). The remaining thin wrappers share a tested shape and
   pass typecheck but lack their own tests. **Add before shipping**, priority order:
   - `useMessages` pagination — `getNextPageParam` / `initialPageParam` in `queries.ts` (distinct behavior, currently untested).
   - `useSetCapabilityActive` optimistic path (mirrors the tested agent toggle).
   - `useUpdateConversation` conditional web-search invalidation.
   - `useChatStream` error path (optimistic user message rolled back on reject) and
     `stop()` (a late `final` after stop must NOT commit — the run-id guard).

2. **Cancellation is best-effort.** `useChatStream().stop()` bumps a run-id and stops
   consuming `textDeltas`, but the underlying request keeps running. True abort needs
   the SDK to thread `AbortSignal` through `sendMessage` (roadmap **WS2**, transport
   seam). The enable point is one commented line in `use-chat-stream.tsx`
   (`// signal: controller.signal`).

3. **No agent-swap mutation.** There is no `setConversationAgent` endpoint today
   (a conversation's agent is fixed at create via `createConversation`), so no
   swap hook was invented. If/when that endpoint lands, its `onSuccess` MUST call
   `invalidateConvoDetailCache(convoId)` — `useDeleteConversation` already models this.

4. **Out of scope here (tracked elsewhere):**
   - The legacy `test/auth/pkce-state-separation.test.ts` still imports `bun:test`
     (org-rule violation) — that is roadmap **WS1** (migrate to vitest), intentionally
     not touched so the two workstreams stay independent. `vitest.config.ts` excludes it.
   - `dist/` is checked-in build output; it shows as changed after `npm run build`.
   - No eslint/prettier in this repo yet (**WS6**), so there is no lint gate to run.

## How to find this again

- **This file:** `bb-client-sdk/src/react/STATUS.md` (on branch `feat/react-query-layer`).
- **The design/spec:** `~/Documents/Apps-Domain-SDK-Thickening-Report.md` + the published Artifact.
- **The roadmap workstreams (WS1–WS7)** referenced above are defined in that report (§4).
