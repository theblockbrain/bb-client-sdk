/**
 * Agentic SSE stream parser.
 *
 * Pure function surface: `parseAgenticStream` takes a `ReadableStream<Uint8Array>`
 * and returns an `AsyncIterable<AgenticSseFrame>`. Callers consume frames and
 * decide what to do with them — no side effects here.
 *
 * Design:
 * - Splits incoming chunks at `\n\n` boundaries (SSE event delimiter).
 * - Extracts `data:` lines from each raw event.
 * - Parses each line via `parseSseDataLine` — tolerant of malformed data
 *   (unknown frame types are passed through as `UnknownFrame`, parse errors
 *   are silently dropped).
 * - `[DONE]` data lines are skipped; the stream ends when the underlying
 *   ReadableStream closes.
 */
import { type AgenticSseFrame, parseSseDataLine } from "./types.js";

/**
 * Parse a `ReadableStream<Uint8Array>` of Server-Sent Events into a typed async
 * iterable of `AgenticSseFrame` values.
 *
 * `[DONE]` data lines are skipped; the stream ends when the underlying
 * ReadableStream closes. Malformed `data:` lines are silently skipped.
 * Unknown frame types are yielded as `{ type: "<unknown>", ... }` — consumers
 * should ignore frame types they don't recognise.
 */
export async function* parseAgenticStream(
  chunks: AsyncIterable<string>,
): AsyncIterable<AgenticSseFrame> {
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += chunk;

    // Split on the SSE event delimiter. The last element may be an incomplete
    // event — keep it in the buffer.
    const parts = buffer.split(/\r\n\r\n|\n\n/);
    buffer = parts.pop() ?? "";

    for (const rawEvent of parts) {
      for (const frame of extractFramesFromRawEvent(rawEvent)) {
        if (frame !== null) yield frame;
      }
    }
  }

  // Flush remaining buffer after the source ends
  if (buffer.trim()) {
    for (const frame of extractFramesFromRawEvent(buffer)) {
      if (frame !== null) yield frame;
    }
  }
}

/**
 * Extract all parseable SSE frames from a single raw event block.
 * A raw event may contain multiple `data:` lines (uncommon but valid SSE).
 * Returns `null` entries for lines that should be skipped — callers filter them.
 */
function extractFramesFromRawEvent(rawEvent: string): Array<AgenticSseFrame | null> {
  const results: Array<AgenticSseFrame | null> = [];
  for (const line of rawEvent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trimStart();
    if (payload === "[DONE]") {
      // Sentinel — signals end of stream. We stop emitting but do not add a frame.
      continue;
    }
    results.push(parseSseDataLine(payload));
  }
  return results;
}

/**
 * Collect all `text-delta` values from a stream into a single string.
 * Convenience helper for the non-streaming (buffered) code path.
 *
 * Does NOT consume approval/suspend frames — those are handled by the client
 * loop in `client.ts` before it calls this helper.
 */
export async function collectTextFromStream(
  frames: AsyncIterable<AgenticSseFrame>,
): Promise<string> {
  let text = "";
  for await (const frame of frames) {
    if (frame.type === "text-delta") {
      // textDelta is the primary AI SDK v6 field; delta is an observed fallback alias.
      const delta =
        (frame as { type: "text-delta"; textDelta?: string; delta?: string }).textDelta ??
        (frame as { type: "text-delta"; textDelta?: string; delta?: string }).delta ??
        "";
      text += delta;
    }
  }
  return text;
}
