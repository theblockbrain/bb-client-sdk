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

2. **Closed (PDEV-7339): cancellation is real.** `useChatStream().stop()` aborts the
   underlying request — `use-chat-stream.tsx:166` passes `signal: controller.signal`
   through the transport into both SSE parsers, and the run-id guard remains only as a
   second line of defence against a late resolve. This entry previously described the
   commented-out line as the enable point; that line is now live.

3. **No agent-swap mutation.** There is no `setConversationAgent` endpoint today
   (a conversation's agent is fixed at create via `createConversation`), so no
   swap hook was invented. If/when that endpoint lands, its `onSuccess` MUST call
   `invalidateConvoDetailCache(convoId)` — `useDeleteConversation` already models this.

4. **Closed (PDEV-7684):** the legacy `test/auth/pkce-state-separation.test.ts`
   imported `bun:test`, lived outside `src/`, and therefore never ran — while the
   security docs cited it as coverage for a CWE-200 defect. It is now
   `src/auth/pkce.test.ts` on vitest and runs in CI. `test/` is gone; every test is
   co-located under `src/`.

## Related

- Conventions, invariants and the verify loop: [`../CLAUDE.md`](../CLAUDE.md) and the
  [`/sdk` skill](../.claude/skills/sdk/SKILL.md).
- The roadmap workstreams (WS1–WS7) are defined in the domain SDK-thickening report.
