/**
 * Blocky SSE stream parser.
 *
 * Blocky returns `text/event-stream` when the `enableStreaming` flag is set on
 * `POST /cortex/completions/v2/user-input`. The wire format is:
 *
 *   event: user_message\r\ndata: {…}\r\n\r\n   — echo of the user's message (skip)
 *   event: message_start\r\ndata: {role, gid}\r\n\r\n  — assistant turn start (skip)
 *   event: new_token\r\ndata: {role, token, gid}\r\n\r\n  — TEXT DELTA (yield token)
 *   event: message_end\r\ndata: {role, gid}\r\n\r\n  — assistant turn end (skip)
 *   event: langfuse_url\r\ndata: {…}\r\n\r\n  — tracing metadata (skip)
 *   event: attached_context\r\ndata: {…}\r\n\r\n  — RAG context (skip)
 *   event: message_ready\r\ndata: {messageIds: […]}\r\n\r\n  — stream done sentinel
 *
 * This parser is intentionally minimal: it only extracts `new_token.token`
 * values. All other event types are silently skipped.
 */

/**
 * Parse a `ReadableStream<Uint8Array>` from Blocky's streaming endpoint into
 * an `AsyncIterable<string>` of text deltas.
 *
 * The iterable completes when the stream closes or a `message_ready` event is
 * received. Malformed `data:` lines are silently skipped.
 */
export async function* parseBlockySseStream(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";
  let done = false;

  for await (const chunk of chunks) {
    buffer += chunk;

    // SSE events are delimited by \r\n\r\n or \n\n
    const parts = buffer.split(/\r\n\r\n|\n\n/);
    // Last element may be an incomplete event — keep it in the buffer
    buffer = parts.pop() ?? "";

    for (const rawEvent of parts) {
      const result = extractBlockyToken(rawEvent);
      if (result.isDone) {
        done = true;
        break;
      }
      if (result.token !== null) yield result.token;
    }
    if (done) break;
  }

  // Flush any remaining buffer after the source ends
  if (!done && buffer.trim()) {
    const result = extractBlockyToken(buffer);
    if (result.token !== null) yield result.token;
  }
}

interface BlockyEventResult {
  /** The text delta to yield, or null if this event carries no text. */
  token: string | null;
  /** True when a `message_ready` event is seen — stream is complete. */
  isDone: boolean;
}

function extractBlockyToken(rawEvent: string): BlockyEventResult {
  const lines = rawEvent.split(/\r?\n/);
  let eventType: string | null = null;
  let dataPayload: string | null = null;

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataPayload = line.slice(5).trim();
    }
  }

  if (eventType === "message_ready") {
    return { token: null, isDone: true };
  }

  if (eventType === "new_token" && dataPayload !== null) {
    try {
      const parsed = JSON.parse(dataPayload) as { token?: string };
      const token = parsed.token ?? null;
      if (token !== null) return { token, isDone: false };
    } catch {
      // Malformed data line — skip
    }
  }

  return { token: null, isDone: false };
}
