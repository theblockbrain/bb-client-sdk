---
applyTo: "src/react/**,src/ui/react.ts,src/ui/useTheme.ts"
---

# The React layer

The **only** place React may be imported. `react` and `@tanstack/react-query` are **optional
peers** — a consumer without them must still be able to install and use every other entry
point, which the clean-room gate asserts by requiring `./react` and `./ui/react` to fail
without React installed.

Peer range is `react >=18 <20`, verified in CI by typechecking against the floor
(`react@18.3.1`). Do not use a React-19-only API without widening that range deliberately.

## Rules specific to this layer

- **Read platform state through a port, not a global.** `useTheme` takes an optional
  `SyncStorageAdapter` and defaults to `createWebStorageAdapter(localStorage)` — resolved
  inside the hook, never at module scope.
- **Freshness policy is not a react-query detail.** TTLs come from `BB_CACHE_POLICY` on
  `./settings` so a Lit or Node surface can honour the same rules. Do not reintroduce
  `staleTime` / `gcTime` literals.
- **Retry policy has one owner.** `bbShouldRetryQuery` delegates to `isRetryableBBError` and
  keeps only the attempt budget. Do not add a second status ladder.
- **Cancellation is real** — `useChatStream().stop()` threads an `AbortSignal` through the
  transport into both SSE parsers. The run-id guard is a second line of defence, not the
  mechanism.
- **Optimistic updates must roll back** on reject, and a late `final` after `stop()` must not
  commit. Both are tested; keep them tested.
- Hooks obey the exhaustive-deps rule. If a dependency must not re-trigger, put it in a
  `useRef` — do not silence the lint.

## Do not import from here

Nothing in `src/api/**`, `src/auth/**`, `src/adapters/**` or `src/ui/index.ts` may import from
`src/react/**`. The dependency direction is one-way: React layer → core, never the reverse.
