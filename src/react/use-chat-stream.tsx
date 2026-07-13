import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type MessageItem,
  type MessageListBody,
  type SendMessageOptions,
  sendMessage,
} from "../api/index.js";
import { bbKeys } from "./keys.js";
import { useBBContext } from "./provider.js";

type ApprovalResolver = NonNullable<SendMessageOptions["approvalResolver"]>;
type MessagesCache = InfiniteData<MessageListBody, number>;

export interface UseChatStreamArgs {
  convoId: string;
  /** Tool-call approval resolver for Agentic turns (forwarded to sendMessage). */
  approvalResolver?: ApprovalResolver;
  /** Max ms between flushes of the live streaming text to React state. Default 60. */
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
 * Cancellation is best-effort today: the SDK does not yet thread an AbortSignal
 * through `sendMessage`, so `stop()` bumps a run-id (so a late `final` is ignored)
 * and stops consuming. The `signal` line is written and commented for a one-line
 * enable once the transport seam (WS2) lands.
 */
export function useChatStream({
  convoId,
  approvalResolver,
  flushIntervalMs = 60,
}: UseChatStreamArgs): UseChatStreamResult {
  const { getAuthContext, orgId } = useBBContext();
  const qc = useQueryClient();
  const liveKey = bbKeys(orgId).messages.list(convoId); // keyword "" = the live chat list

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [error, setError] = useState<Error | null>(null);

  const bufferRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const runIdRef = useRef(0);

  const clearFlush = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      clearFlush();
    };
  }, [clearFlush]);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      if (mountedRef.current) setStreamingText(bufferRef.current);
    }, flushIntervalMs);
  }, [flushIntervalMs]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    runIdRef.current += 1; // any late `final` for the aborted run becomes a no-op
    clearFlush();
    if (mountedRef.current) setIsStreaming(false);
  }, [clearFlush]);

  const reset = useCallback(() => {
    bufferRef.current = "";
    if (mountedRef.current) {
      setStreamingText("");
      setError(null);
    }
  }, []);

  const send = useCallback(
    async (content: string) => {
      if (isStreaming) return; // one active stream per hook instance
      const runId = ++runIdRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      // Optimistic user message straight into the cache.
      await qc.cancelQueries({ queryKey: liveKey });
      const previous = qc.getQueryData<MessagesCache>(liveKey);
      const optimisticUser: MessageItem = {
        role: "user",
        content,
        id: `optimistic-${crypto.randomUUID()}`,
        pending: true,
      };
      qc.setQueryData<MessagesCache>(liveKey, prev => insertLiveMessage(prev, optimisticUser));

      bufferRef.current = "";
      setError(null);
      setStreamingText("");
      setIsStreaming(true);

      try {
        const stream = await sendMessage(getAuthContext(), convoId, content, {
          enableStreaming: true,
          approvalResolver,
          // signal: controller.signal,  // ← enable once the SDK threads AbortSignal (WS2)
        });

        for await (const delta of stream.textDeltas) {
          if (controller.signal.aborted || runId !== runIdRef.current) break;
          bufferRef.current += delta;
          scheduleFlush();
        }

        const finalText = await stream.final; // resolves independent of iteration
        if (runId !== runIdRef.current || controller.signal.aborted) return;

        const assistant: MessageItem = { role: "assistant", content: finalText };
        qc.setQueryData<MessagesCache>(liveKey, prev => insertLiveMessage(prev, assistant));
        void qc.invalidateQueries({ queryKey: bbKeys(orgId).messages.forConvo(convoId) });

        clearFlush();
        bufferRef.current = "";
        if (mountedRef.current) {
          setStreamingText("");
          setIsStreaming(false);
        }
      } catch (err) {
        if (runId !== runIdRef.current) return;
        qc.setQueryData<MessagesCache>(liveKey, previous); // roll back the optimistic user message
        void qc.invalidateQueries({ queryKey: bbKeys(orgId).messages.forConvo(convoId) });
        clearFlush();
        if (mountedRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsStreaming(false);
        }
      }
    },
    [
      isStreaming,
      qc,
      liveKey,
      getAuthContext,
      convoId,
      approvalResolver,
      scheduleFlush,
      clearFlush,
      orgId,
    ],
  );

  return { send, isStreaming, streamingText, error, stop, reset };
}
