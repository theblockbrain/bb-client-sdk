import { describe, expect, it } from "vitest";
import { collectTextFromStream, parseAgenticStream } from "./sse.js";
import type { AgenticSseFrame } from "./types.js";

/**
 * Build an `AsyncIterable<string>` from chunks, so a test can control exactly
 * where the network boundary falls — the split point is the whole point of a
 * buffering parser, and a single-chunk fixture would never exercise it.
 *
 * Was a `ReadableStream<Uint8Array>` before PDEV-7338 moved the parser onto the
 * transport, which now owns byte decoding. Same fixtures, one less layer.
 */
async function* streamOf(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

/** A source a test can feed and close by hand, to observe timing rather than totals. */
function pushable() {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const nudge = () => {
    wake?.();
    wake = null;
  };
  return {
    push(chunk: string) {
      queue.push(chunk);
      nudge();
    },
    close() {
      closed = true;
      nudge();
    },
    async *[Symbol.asyncIterator](): AsyncIterator<string> {
      while (true) {
        for (const chunk of queue.splice(0)) yield chunk;
        if (closed) return;
        await new Promise<void>(resolve => {
          wake = resolve;
        });
      }
    },
  };
}

async function collect(chunks: AsyncIterable<string>): Promise<AgenticSseFrame[]> {
  const out: AgenticSseFrame[] = [];
  for await (const frame of parseAgenticStream(chunks)) out.push(frame);
  return out;
}

const delta = (text: string) => `data: ${JSON.stringify({ type: "text-delta", textDelta: text })}`;

describe("parseAgenticStream", () => {
  it("yields text-delta frames split on LF", async () => {
    const frames = await collect(streamOf(`${delta("He")}\n\n${delta("llo")}\n\n`));
    expect(frames).toEqual([
      { type: "text-delta", textDelta: "He" },
      { type: "text-delta", textDelta: "llo" },
    ]);
  });

  it("yields text-delta frames split on CRLF", async () => {
    // A proxy in front of the agent host can normalise line endings to CRLF.
    const frames = await collect(streamOf(`${delta("He")}\r\n\r\n${delta("llo")}\r\n\r\n`));
    expect(frames).toEqual([
      { type: "text-delta", textDelta: "He" },
      { type: "text-delta", textDelta: "llo" },
    ]);
  });

  it("streams CRLF events incrementally rather than only at close", async () => {
    // The regression this guards: splitting on "\n\n" alone still recovered the
    // text via the post-close buffer flush, so a correctness-only assertion
    // passed while every frame arrived in one burst at the end — first-token
    // latency silently became whole-response latency. Assert the FIRST frame is
    // available before the stream closes.
    const source = pushable();
    const iterator = parseAgenticStream(source)[Symbol.asyncIterator]();
    source.push(`${delta("first")}\r\n\r\n`);

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "text-delta", textDelta: "first" });

    source.close();
  });

  it("keeps a partial event buffered across chunk boundaries", async () => {
    const whole = `${delta("split me")}\n\n`;
    const cut = Math.floor(whole.length / 2);
    const frames = await collect(streamOf(whole.slice(0, cut), whole.slice(cut)));
    expect(frames).toEqual([{ type: "text-delta", textDelta: "split me" }]);
  });

  it("flushes a trailing event that never got its delimiter", async () => {
    const frames = await collect(streamOf(delta("no trailing newline")));
    expect(frames).toEqual([{ type: "text-delta", textDelta: "no trailing newline" }]);
  });

  it("skips the [DONE] sentinel without yielding a frame", async () => {
    const frames = await collect(streamOf(`${delta("hi")}\n\ndata: [DONE]\n\n`));
    expect(frames).toEqual([{ type: "text-delta", textDelta: "hi" }]);
  });

  it("skips malformed data lines but keeps parsing the rest", async () => {
    const frames = await collect(
      streamOf(`data: {not json\n\n${delta("survived")}\n\ndata: {"noType":true}\n\n`),
    );
    expect(frames).toEqual([{ type: "text-delta", textDelta: "survived" }]);
  });

  it("ignores non-data lines such as comments and event names", async () => {
    const frames = await collect(streamOf(`: keep-alive\nevent: message\n${delta("ok")}\n\n`));
    expect(frames).toEqual([{ type: "text-delta", textDelta: "ok" }]);
  });

  it("yields every data line when one event carries several", async () => {
    const frames = await collect(streamOf(`${delta("a")}\n${delta("b")}\n\n`));
    expect(frames).toEqual([
      { type: "text-delta", textDelta: "a" },
      { type: "text-delta", textDelta: "b" },
    ]);
  });

  it("passes an unrecognised frame type through untouched", async () => {
    // Forward-compatibility: a frame the SDK has never heard of must reach the
    // consumer rather than being dropped, so the server can add one without a
    // synchronised SDK release.
    const frames = await collect(streamOf(`data: {"type":"data-brand-new","data":{"x":1}}\n\n`));
    expect(frames).toEqual([{ type: "data-brand-new", data: { x: 1 } }]);
  });

  it("parses the three previously-missing server frames", async () => {
    const frames = await collect(
      streamOf(
        `data: {"type":"data-tool-call-too-large","data":{"toolName":"createTicket"}}\n\n` +
          `data: {"type":"data-error","data":{"code":"MASTRA_ERROR","message":"boom","traceId":"t1","errorClass":"E","retryable":false,"partial":true}}\n\n` +
          `data: {"type":"data-connect-integration","id":"connect:x","data":{"providerKey":"sharepoint_microsoft-tenant","toolId":"listFiles"}}\n\n`,
      ),
    );
    expect(frames.map(f => f.type)).toEqual([
      "data-tool-call-too-large",
      "data-error",
      "data-connect-integration",
    ]);
  });
});

describe("collectTextFromStream", () => {
  it("concatenates text-delta values and ignores everything else", async () => {
    const text = await collectTextFromStream(
      parseAgenticStream(
        streamOf(`${delta("Hel")}\n\ndata: {"type":"message-start"}\n\n${delta("lo")}\n\n`),
      ),
    );
    expect(text).toBe("Hello");
  });

  it("reads the `delta` alias when `textDelta` is absent", async () => {
    // Both field names are observed in the wild across server builds.
    const text = await collectTextFromStream(
      parseAgenticStream(streamOf(`data: {"type":"text-delta","delta":"aliased"}\n\n`)),
    );
    expect(text).toBe("aliased");
  });
});
