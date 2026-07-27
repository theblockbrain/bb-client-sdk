# `./react` layer — known gaps

**Landed:** PR #12 (`feat(PDEV-6796)`, merged 2026-07-14) · **Owner:** Chiheb Hmida
**What this is:** the `@theblockbrain/bb-client-sdk/react` React Query data layer
(provider + `bbKeys` + query/mutation hooks + `useChatStream`), built test-first.

Verify locally on the Node version pinned in `.nvmrc`:

```bash
npx vitest run src/react   # 12 tests, 5 files
npm run typecheck          # tsc --noEmit over all of src
npm run build              # tsup + tsc → dist/react/index.{js,d.ts}
```

`react` and `@tanstack/react-query` are peers — externalized, never bundled.

## Deliberate gaps, for the next pass

1. **Test coverage is representative, not exhaustive.** Directly unit-tested behaviours:
   `bbKeys` scoping (`keys.test.ts`), the retry predicate (`provider.test.ts`), query
   wiring via `useBots` (`queries.test.tsx`), optimistic rollback + the hidden-cache
   purge on delete (`mutations.test.tsx`), and `useChatStream` cache-commit
   (`use-chat-stream.test.tsx`). The remaining thin wrappers share a tested shape and
   pass typecheck but lack their own tests. Priority order to close:
   - `useMessages` pagination — `getNextPageParam` / `initialPageParam` in `queries.ts` (distinct behaviour, currently untested).
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

4. **Out of scope here (tracked elsewhere):** the legacy
   `test/auth/pkce-state-separation.test.ts` still imports `bun:test` (org-rule
   violation) — that is roadmap **WS1** (migrate to vitest), intentionally not touched
   so the two workstreams stay independent. `vitest.config.ts` only includes
   `src/**/*.test.{ts,tsx}`, so it never runs.

## Related

- Conventions, invariants and the verify loop: [`../CLAUDE.md`](../CLAUDE.md) and the
  [`/sdk` skill](../.claude/skills/sdk/SKILL.md).
- The roadmap workstreams (WS1–WS7) are defined in the domain SDK-thickening report.
