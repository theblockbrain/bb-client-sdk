/**
 * `@theblockbrain/bb-client-sdk/react` — the React Query data layer.
 *
 * A thin, optional, tree-shakeable binding over the framework-agnostic logic
 * core (`../api`, `../auth`, `../settings`). `react` and `@tanstack/react-query`
 * are OPTIONAL peers, so non-React consumers (Office add-ins, Lit web components)
 * never pull this graph in.
 *
 * Usage:
 *   import { BBClientProvider, useBots, useChatStream } from "@theblockbrain/bb-client-sdk/react";
 */

export { type BBKeys, bbKeys } from "./keys.js";
export * from "./mutations.js";
export {
  BBClientProvider,
  type BBClientProviderProps,
  bbShouldRetryQuery,
  type CreateBBQueryClientOptions,
  createBBQueryClient,
  useBBContext,
} from "./provider.js";
export * from "./queries.js";

export {
  type UseChatStreamArgs,
  type UseChatStreamResult,
  useChatStream,
} from "./use-chat-stream.js";
