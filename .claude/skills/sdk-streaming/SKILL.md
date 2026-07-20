---
name: sdk-streaming
description: "Use when changing the SSE/streaming layer in bb-client-sdk — blocky-sse.ts, stream-result.ts (MessageStream), sendMessage routing in messages.ts, or the ./react useChatStream hook. Governs first-token latency, mid-stream drops, reconnection, and cancellation."
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# sdk-streaming

> **Inherits from**: `/sdk` — see that skill for the adapter matrix, invariants, and verification loop. Do not duplicate them here; this skill only adds streaming-specific procedure.

The streaming layer is the hottest path in the SDK: it fans out to every chat surface and is the one place where the "no runtime assumptions" invariant (see `/sdk`, invariant **B**) bites hardest — `fetch`/`ReadableStream` behave differently in a browser, in Node (Slack), in a Lit CDN bundle, and in React Native. A regression here is a cross-adapter defect. Follow these phases exactly.

Baseline code-style rules (import order, no `any`, early returns, error handling, verification checklist) live in the org **Code Cleanup & Refactoring** standard — obey it; don't restate it.

---

## Phase 1 — Map the layer before you touch it

Read every file below in full before editing any of them. These are the only files in the streaming path; do not assume a symbol exists — Read and confirm.

| Concern | File | Key symbols (verified) |
| --- | --- | --- |
| Blocky SSE parser | `src/api/blocky-sse.ts` | `parseBlockySseStream(body: ReadableStream<Uint8Array>): AsyncIterable<string>`; internal `extractBlockyToken` |
| Agentic SSE parser | `src/api/agentic/sse.ts` | `parseAgenticStream(body): AsyncIterable<AgenticSseFrame>`; `collectTextFromStream` |
| Agentic client / resume loop | `src/api/agentic/client.ts` | `callAgenticStream(options): AsyncIterable<string>`; `ApprovalResolver`, `autoApproveResolver`, `buildAgenticStreamUrl` |
| Agentic frame types / guards | `src/api/agentic/types.ts` | `AgenticSseFrame`, `parseSseDataLine`, `isTextDeltaFrame`, `isToolCallApprovalFrame`, `isToolCallSuspendedFrame` |
| Unified stream shape | `src/api/stream-result.ts` | `MessageStream {textDeltas, final}`; `createMessageStream(source)`; `wrapStringAsStream(text)` |
| Send + routing | `src/api/messages.ts` | `sendMessage` (overloaded), `SendMessageStreamOptions`, module `convoDetailCache`, `invalidateConvoDetailCache` |
| React consumer | `src/react/use-chat-stream.tsx` | `useChatStream(args): {send, isStreaming, streamingText, error, stop, reset}` |

**Do not assume the Agentic parser's path.** It is NOT alongside `blocky-sse.ts`; it lives under `src/api/agentic/` (`sse.ts` + `client.ts` + `types.ts`). Confirm with `grep -rn "parseAgenticStream\|callAgenticStream" src/api` before editing.

What the map has to tell you, and the exact wire facts to preserve:

- **Blocky wire format** (`blocky-sse.ts` header comment): events `user_message`, `message_start`, `new_token`, `message_end`, `langfuse_url`, `attached_context`, `message_ready`. Only `new_token.token` is yielded; **`message_ready` is the terminal sentinel** (sets `isDone`). Events split on `/\r\n\r\n|\n\n/`; the trailing partial event is kept in `buffer`; the buffer is flushed once after the stream closes.
- **Agentic wire format** (`agentic/sse.ts`): events split on `\n\n`; only `data:` lines are read; **`[DONE]` is the sentinel** (skipped, not yielded); unknown frames pass through as `UnknownFrame` and are ignored by the client loop. Text lives in `text-delta` frames, field `frame.textDelta ?? frame.delta ?? ""` (AI-SDK-v6 primary field + observed alias — preserve both).
- **Routing** (`messages.ts`): `sendMessage` calls `getCachedConvoAgent` → `getConversationDetail` (the conversation's `agent` field). Truthy `agentId` ⇒ **Agentic path** (`callAgenticStream`); falsy ⇒ **Blocky path** (`POST /cortex/completions/v2/user-input`, `enableStreaming` in the body). The agent-per-`convoId` result is cached module-level for `CACHE_TTL_MS` (5 min); `invalidateConvoDetailCache(convoId)` evicts it. If you add an agent-swap path, its `onSuccess` MUST call `invalidateConvoDetailCache` (mirrors the `./react` STATUS.md gap #3).
- **Agentic requires a user id**: `resourceId = ctx.userId ?? subFromAccessToken(ctx.token) ?? null`, else a hard `throw` — Agentic is unavailable in `api-key` mode (see `/sdk` auth model). Keep this three-tier fallback and its error message intact.
- **Unified shape**: both paths funnel through `createMessageStream(source)`. `final` resolves independently of whether `textDeltas` is consumed (an internal drain runs immediately; `void final.catch(() => {})` suppresses spurious unhandled-rejection). A source error is captured as `drainError` and **re-thrown into `textDeltas`** — preserve this so consumers see failures.
- **`wrapStringAsStream` is public but currently unused internally** (exported from `./api`, in the contract snapshot; the Blocky path today parses real SSE via `parseBlockySseStream`, not the single-delta fallback). Do not delete it without a contract-test + snapshot update (Phase 5).

---

## Phase 2 — The transport reality (why this layer is fragile)

Both send paths call the global `fetch` directly (`messages.ts` ~L161; `agentic/client.ts` ~L141) and both parsers consume a `ReadableStream<Uint8Array>`. That is a **browser / Node-20+ assumption baked into the core** — and it is the known constraint, not a thing to "fix" casually:

- **React Native (blocky-mobile)**: `fetch`/`ReadableStream` streaming is unstable; RN needs XHR or an `rn-sse`/EventSource shim. This is the real mobile streaming blocker.
- **Lit web-component (b2b-webcomponents / blocky-chat)**: streams via `EventSource` today.
- **Add-ins + browser SPA**: `fetch` + `ReadableStream` works.

The fix is the **transport seam (roadmap WS2)** — inject the byte-stream source (and the `AbortSignal`) instead of calling `fetch` inline, so each adapter supplies its own transport. Until WS2 lands:

- **Do not add new hard `fetch`/`ReadableStream`/`EventSource`/`window` references to the core streaming path.** New transport-dependent code must be shaped so WS2 can inject it (a parameter or adapter), not a global.
- **Cancellation is best-effort, by design.** `useChatStream().stop()` bumps `runIdRef` and stops consuming `textDeltas`, but the underlying request keeps running — the SDK does not thread `AbortSignal` through `sendMessage` yet. The enable point is the single commented line in `use-chat-stream.tsx` (`// signal: controller.signal, // ← enable once the SDK threads AbortSignal (WS2)`).
- **The late-`final` run-id guard MUST hold.** Every commit-to-state/commit-to-cache in `use-chat-stream.tsx` re-checks `controller.signal.aborted || runId !== runIdRef.current` after each `await` (before iterating, before `await stream.final`, after it, and in `catch`). If you touch this hook, keep that guard after *every* await — a stale run writing to the cache is a data-corruption bug, and `stop()` already invalidates the convo query to reconcile the still-running request.

---

## Phase 3 — Correctness cases to preserve across all adapters

Any change must keep every row true for **both** parsers and **all three transports** (EventSource / XHR-rn-sse / fetch). Walk this table for your diff:

| Case | Blocky (`blocky-sse.ts`) | Agentic (`agentic/sse.ts` + `client.ts`) | What must stay true |
| --- | --- | --- | --- |
| Connect success | first `new_token` yields | first `text-delta` yields | first token surfaces ASAP (first-token latency, Phase 4) |
| Mid-stream drop | reader `done` before sentinel | reader `done` before `[DONE]` | ⚠ today both just break + flush → a drop looks like a *short clean completion*, not an error (see gap below) |
| Terminal sentinel | `message_ready` → `isDone` | `[DONE]` skipped, stream ends on close | sentinel handling not swallowed; buffered partial flushed once |
| Reconnection | none today | none today | if you add retry, it must be idempotent and NOT double-yield already-emitted deltas |
| Parser auto-routing | agent falsy | agent truthy (needs userId) | routing stays on the conversation's `agent`; cache TTL + `invalidateConvoDetailCache` respected |
| User-cancel vs error | run-id guard (hook) | run-id guard (hook) | cancel is silent (no `error`); a source throw rejects `final` and re-throws into `textDeltas` |
| Tool approval / suspend | n/a | `callAgenticStream` resume loop (`ApprovalResolver`, `maxAutoResumes` = 3) | resume uses stable `id` + `userMessage`; approval/suspend frames never leak as text |

**Known correctness gap to respect (do not silently regress, and prefer to close it if your change is in this area):** neither parser distinguishes a mid-stream TCP/network drop from a normal end — both simply break the read loop and resolve `final` with whatever accumulated, because they don't track whether the terminal sentinel (`message_ready` / `[DONE]`) was actually seen. That means a dropped stream is indistinguishable from a clean short response, and `stream_dropped` telemetry (Phase 4) cannot be emitted accurately until sentinel-seen tracking is added. If your change touches drop/terminal handling, add a "saw terminal?" flag and surface a distinct dropped state.

---

## Phase 4 — Telemetry hooks (hard release gate)

Streaming is where the health-telemetry invariant (`/sdk`, invariant **E**) is most measurable. The **AnalyticsAdapter** seam is **planned** (**WS9** — a peer of `StorageAdapter`/`IdentityAdapter`, not yet on `main`); once it lands, emit through `trackEvent(...)` from `@theblockbrain/bb-client-sdk/analytics`. The `stream_*` events are **not auto-emitted by the core** — they are wired incrementally at their call sites — so when you add or move streaming logic, wire these events (or leave a clearly-marked seam for them). Every name below is a key of the typed `AnalyticsEventMap` defined in the telemetry reference — emit them **verbatim** (no shorthand); the seam's types reject anything else:

| Event | Emit at | Notes |
| --- | --- | --- |
| `stream_start` | send accepted, before first byte | one per turn |
| `stream_first_token` | first delta yielded from either parser | this IS the first-token-latency SLO signal |
| `stream_complete` | terminal sentinel seen + `final` resolved | carries assembled length |
| `stream_dropped` | reader closed before sentinel | requires the "saw terminal?" flag from Phase 3 |
| `stream_reconnect` | on a retry attempt (if/when added) | idempotency required |
| `api_error` | on `BBApiError` from a send path | props `{statusCode, endpoint}`; scrub `responseBody` — never log tokens |

Do **not** invent a per-surface analytics call inside the core; emit through the adapter seam (`trackEvent`) so Slack/Lit/RN/add-ins each wire it to Mixpanel + Sentry + Faro. Wiring these on a surface is a **release-gate checklist item** — nothing ships without both product analytics and health telemetry. Full taxonomy, the typed `AnalyticsEventMap`, the identity model (Zitadel `sub` as distinct id, org as group, no PII), and the gate checklist: **[../sdk/references/telemetry-release-gate.md](../sdk/references/telemetry-release-gate.md)**.

---

## Phase 5 — Verify (full loop + streaming tests + cross-adapter)

Run the same gate CI runs (`.github/workflows/ci.yml`), in order — this is the real merge gate:

```bash
npm run lint:biome && npm run lint:types && npm run typecheck && npm test && npm run build && npm run check:package
```

Then the streaming-specific checks:

1. **React streaming test**: `src/react/use-chat-stream.test.tsx` (vitest + jsdom). It currently covers the cache-commit path only. STATUS.md (`src/react/STATUS.md`, gap #1) flags two untested behaviors you must add tests for if you touch the hook: the **error path** (optimistic user message rolled back on reject) and **`stop()`** (a late `final` after stop must NOT commit — the run-id guard).
2. **Close the parser test gap.** There are **no** unit tests today for `blocky-sse.ts`, `stream-result.ts`, or `agentic/sse.ts`. Per the org test-first standard, add table-driven tests for the parser you change: connect, mid-stream drop, sentinel, malformed `data:` line skipped, unknown frame ignored, multi-`data:` event. Feed a hand-built `ReadableStream<Uint8Array>` (see the wire samples in each file's header comment) — no network.
3. **Cross-adapter pass** (invariant **C**): the transport differs per surface — **Lit uses `EventSource`, RN uses XHR/`rn-sse`, add-ins/browser use `fetch`**. A streaming change must be reasoned through all three; a change that only works under `fetch` is a defect. Walk the adapter matrix: **[../sdk/references/adapters.md](../sdk/references/adapters.md)**.
4. **Public-API contract** (`src/public-api.contract.test.ts` + its `.snap`): any change to `MessageStream`, the `sendMessage` overloads, `SendMessageStreamOptions`, `createMessageStream`, or `wrapStringAsStream` fails the contract test. If the change is intentional, update the snapshot deliberately, then **canary-test in ms-outlook-addin before promoting to `latest`** (the stale `^0.7.3` pin is the cautionary tale).

Commit with a Jira-scoped Conventional Commit on a `type/PDEV-xxx/desc` branch (lefthook enforces both) — see `/sdk`.

---

### Dual-audience note

- **SDK maintainers**: you own the parsers, `createMessageStream`, routing, the transport seam (WS2), and the planned analytics seam (WS9). Keep the core transport-agnostic and the run-id/`final` contracts intact.
- **Adapter developers**: you consume `sendMessage(..., { enableStreaming: true })` → `MessageStream`, or `useChatStream` in React. Iterate `textDeltas` for live text and `await final` for the committed result (safe to do either or both). On non-fetch transports (Lit/RN) you are the transport until WS2 — do not assume the SDK will abort your request for you; wire your own cancel, and emit your `stream_*` telemetry via `trackEvent(...)` through your registered adapter (the analytics seam is planned — WS9).
