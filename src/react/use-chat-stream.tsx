import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCryptoAdapter } from "../adapters/crypto.js";
import {
  type ApprovalResolver,
  type MessageItem,
  type MessageListBody,
  sendMessage,
} from "../api/index.js";
import { createStreamCoalescer } from "../utils/stream-coalescer.js";
import { bbKeys } from "./keys.js";
import { useBBContext } from "./provider.js";

type MessagesCache = InfiniteData<MessageListBody, number>;

export interface UseChatStreamArgs {
  convoId: string;
  /** Tool-call approval resolver for Agentic turns (forwarded to sendMessage). */
  approvalResolver?: ApprovalResolver;
  /**
   * Max ms between flushes of the live streaming text to React state. Default 60.
   *
   * Always honoured as a rate, on every platform: `createStreamCoalescer` uses a
   * timer whenever an interval is given, and only follows the display when one
   * is omitted. This hook never omits it, so a React Native consumer behaves
   * exactly like a browser one.
   */
  flushIntervalMs?: number;
}

export interface UseChatStreamResult {
  send: (content: string) => Promise<void>;
  isStreaming: boolean;
  streamingText: string;
  error: Error | null;
  stop: () => void;
  reset: () => void;
}

/**
 * Insert a message at the newest end of the paginated cache (front of page 0,
 * assuming page 1 = newest batch). No-op when the list was never fetched — the
 * post-stream invalidate then fetches it fresh instead.
 */
function insertLiveMessage(
  prev: MessagesCache | undefined,
  msg: MessageItem,
): MessagesCache | undefined {
  if (!prev || prev.pages.length === 0) return prev;
  const [first, ...rest] = prev.pages;
  return { ...prev, pages: [{ ...first, data: [msg, ...first.data] }, ...rest] };
}

/**
 * Streaming chat turn. Streaming fits neither `useQuery` nor `useMutation`, so
 * this hook *uses* the React Query cache for the durable message list while
 * holding the in-flight token stream in local state:
 *
 *   - live tokens render from `streamingText` (transient, not cached);
 *   - the optimistic user message and the finished assistant message live in
 *     the messages infinite-query cache;
 *   - on `final`, ownership transfers from local state to the cache in one commit.
 *
 * `stop()` really cancels (PDEV-7339). The controller's signal is threaded through
 * `sendMessage` into the transport, so aborting ends the in-flight request rather
 * than merely abandoning it. The run-id guard stays: it covers the window between
 * an abort and the request actually unwinding, and a late `final` writing to the
 * cache would be data corruption, not just noise.
 *
 * The post-stop `invalidateQueries` also stays. It reconciles the optimistic user
 * message against server truth — the server may well have persisted the turn
 * before the abort reached it, so "cancelled" client-side is not "did not happen".
 */
export function useChatStream({
  convoId,
  approvalResolver,
  flushIntervalMs = 60,
}: UseChatStreamArgs): UseChatStreamResult {
  const { getAuthContext, orgId } = useBBContext();
  const qc = useQueryClient();
  // Memoized so `send`/`stop` keep a stable identity across renders.
  const liveKey = useMemo(() => bbKeys(orgId).messages.list(convoId), [orgId, convoId]);

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<Error | null>(null);

  const bufferRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const runIdRef = useRef(0);
  // Synchronous active-stream guard — `isStreaming` state lags a render, so two
  // synchronous send() calls could otherwise both start a stream.
  const streamingRef = useRef(false);

  // One coalescer per interval. The mounted check stays on this side: the
  // coalescer knows nothing about React, and a delivery that lands after unmount
  // must not set state.
  const coalescer = useMemo(
    () =>
      createStreamCoalescer<string>({
        intervalMs: flushIntervalMs,
        onFlush: text => {
          if (mountedRef.current) setStreamingText(text);
        },
      }),
    [flushIntervalMs],
  );

  // Cancels on unmount AND when a changed `flushIntervalMs` replaces the
  // coalescer, so a delivery scheduled by the outgoing one cannot write after it
  // stopped being the live one.
  useEffect(() => () => coalescer.cancel(), [coalescer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    runIdRef.current += 1; // any late `final` for the aborted run becomes a no-op
    streamingRef.current = false;
    coalescer.cancel();
    // Reconcile the cache: without this the optimistic (pending) user message would stay
    // pending forever, since the SDK request can't be aborted yet — refetch the server truth.
    void qc.invalidateQueries({ queryKey: bbKeys(orgId).messages.forConvo(convoId) });
    if (mountedRef.current) setIsStreaming(false);
  }, [coalescer, qc, orgId, convoId]);

  // Clears the composer mid-turn without ending the turn, so it must cancel the
  // coalescer itself. A delivery armed before this point carries the value
  // captured at push time, not whatever `bufferRef` holds when it fires, so
  // clearing the buffer alone would let the pre-reset partial repaint up to
  // `flushIntervalMs` later. Every other clearing path (`stop`, the final commit,
  // the catch) already cancels for the same reason.
  const reset = useCallback(() => {
    bufferRef.current = "";
    coalescer.cancel();
    if (mountedRef.current) {
      setStreamingText("");
      setError(null);
    }
  }, [coalescer]);

  const send = useCallback(
    async (content: string) => {
      // Synchronous guard — `isStreaming` state lags a render, so gate on the ref to keep
      // two synchronous send() calls from starting concurrent streams.
      if (streamingRef.current) return;
      streamingRef.current = true;
      const runId = ++runIdRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      let previous: MessagesCache | undefined;
      try {
        // Optimistic user message straight into the cache — only when the list is already
        // loaded; otherwise the post-stream invalidate fetches it fresh (no phantom entry).
        await qc.cancelQueries({ queryKey: liveKey });
        previous = qc.getQueryData<MessagesCache>(liveKey);
        if (previous) {
          const optimisticUser: MessageItem = {
            role: "user",
            content,
            id: `optimistic-${getCryptoAdapter().randomUUID()}`,
            pending: true,
          };
          qc.setQueryData<MessagesCache>(liveKey, prev => insertLiveMessage(prev, optimisticUser));
        }

        bufferRef.current = "";
        setError(null);
        setStreamingText("");
        setIsStreaming(true);

        const stream = await sendMessage(getAuthContext(), convoId, content, {
          enableStreaming: true,
          approvalResolver,
          signal: controller.signal,
        });

        for await (const delta of stream.textDeltas) {
          if (controller.signal.aborted || runId !== runIdRef.current) break;
          bufferRef.current += delta;
          coalescer.push(bufferRef.current);
        }

        // Bail before awaiting `final` if the run was stopped/superseded — the SDK request
        // can't be aborted yet, so awaiting would keep send() pending needlessly.
        if (controller.signal.aborted || runId !== runIdRef.current) return;
        const finalText = await stream.final; // resolves independent of iteration
        if (controller.signal.aborted || runId !== runIdRef.current) return;

        const assistant: MessageItem = { role: "assistant", content: finalText };
        qc.setQueryData<MessagesCache>(liveKey, prev => insertLiveMessage(prev, assistant));
        void qc.invalidateQueries({ queryKey: bbKeys(orgId).messages.forConvo(convoId) });

        // Discarded, not flushed: `streamingText` is about to be cleared and the
        // finished answer now lives in the message cache, so a late partial would
        // paint over a completed message.
        coalescer.cancel();
        bufferRef.current = "";
        if (mountedRef.current) {
          setStreamingText("");
          setIsStreaming(false);
        }
      } catch (err) {
        if (runId !== runIdRef.current) return;
        qc.setQueryData<MessagesCache>(liveKey, previous); // roll back the optimistic user message
        void qc.invalidateQueries({ queryKey: bbKeys(orgId).messages.forConvo(convoId) });
        coalescer.cancel();
        if (mountedRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsStreaming(false);
        }
      } finally {
        // Release the guard only if this run is still current — a later stop()/send() owns it otherwise.
        if (runId === runIdRef.current) streamingRef.current = false;
      }
    },
    [qc, liveKey, getAuthContext, convoId, approvalResolver, coalescer, orgId],
  );

  return { send, isStreaming, streamingText, error, stop, reset };
}
