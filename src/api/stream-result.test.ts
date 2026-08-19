import { afterEach, describe, expect, it } from "vitest";

import type { AnalyticsAdapter } from "../analytics/index.js";
import { resetAnalyticsAdapter, setAnalyticsAdapter } from "../analytics/index.js";
import { BBApiError } from "./errors.js";
import { createMessageStream, type StreamTelemetry, wrapStringAsStream } from "./stream-result.js";

/**
 * The stream half of the taxonomy, tested through the emitted events rather than
 * through the private classifier — a reason label only matters if it survives the
 * path a real drop takes, and `dropReason` is not exported.
 */

interface RecordedEvent {
  event: string;
  props: Record<string, unknown>;
}

function makeRecorder(): { adapter: AnalyticsAdapter; events: RecordedEvent[] } {
  const events: RecordedEvent[] = [];
  return {
    events,
    adapter: {
      track: (event, props) => {
        events.push({ event, props });
      },
      captureError: () => {},
    },
  };
}

const TELEMETRY: StreamTelemetry = {
  route: "chat",
  conversation_id: "convo-1",
  request_id: "req-1",
};

/**
 * An async source that yields `deltas`, then fails with `failWith` if given.
 *
 * The `as Error` is load-bearing and is not a suppression in disguise: one case
 * below deliberately fails with a plain string, because a source CAN reject with a
 * non-Error (a raw server payload) and the classifier has to file that as `unknown`
 * rather than crash on it. Both `only-throw-error` and `prefer-promise-reject-errors`
 * are type-based, so stating the intent in the type is what satisfies them —
 * whereas an ignore comment would just hide the question.
 */
function source(deltas: string[], failWith?: unknown): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const delta of deltas) yield await Promise.resolve(delta);
      if (failWith !== undefined) throw failWith as Error;
    },
  };
}

/** Drain a stream to completion, swallowing the rejection so assertions can run. */
async function drain(stream: { final: Promise<string> }): Promise<void> {
  await stream.final.catch(() => undefined);
}

afterEach(() => resetAnalyticsAdapter());

describe("createMessageStream telemetry", () => {
  it("emits the success funnel in order, with ttft on the first token only", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    const stream = createMessageStream(source(["a", "b", "c"]), TELEMETRY);
    await drain(stream);

    expect(events.map(e => e.event)).toEqual([
      "stream_started",
      "message_first_token",
      "message_completed",
    ]);
    // One first-token event for three deltas — the milestone is per turn, not per chunk.
    expect(events.filter(e => e.event === "message_first_token")).toHaveLength(1);
    expect(events[0].props).toEqual({
      route: "chat",
      request_id: "req-1",
      conversation_id: "convo-1",
    });
    expect(events[1].props.ttft_ms).toEqual(expect.any(Number));
    expect(events[2].props).toMatchObject({ route: "chat", outcome: "success" });
  });

  it("emits nothing at all when no telemetry is supplied", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    await drain(createMessageStream(source(["a"])));

    expect(events).toEqual([]);
  });

  it("closes the funnel AND reports transport health when the source throws", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    await drain(createMessageStream(source(["a"], new Error("boom")), TELEMETRY));

    // Both, and not redundant: the drop is transport health, `message_completed`
    // is the funnel's denominator for failed turns.
    expect(events.map(e => e.event)).toContain("stream_dropped");
    const completed = events.find(e => e.event === "message_completed");
    expect(completed?.props).toMatchObject({ outcome: "error" });
  });
});

describe("stream_dropped.reason is classified from BBApiError.kind", () => {
  /**
   * The transport never surfaces a `DOMException` named `AbortError` — it converts
   * a caller abort into `BBApiError{statusCode: 0, kind: "aborted"}` (see
   * `toTransportError` in transport.ts). A classifier that reads `statusCode`
   * therefore files every transport-level drop as `unknown`, and `errors.ts` says
   * as much: "Check `BBApiError.kind` first … `statusCode` alone cannot tell a
   * network drop from a timeout — both report 0."
   */
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["a caller abort", new BBApiError("aborted", 0, { kind: "aborted" }), "client_abort"],
    ["a dead connection", new BBApiError("net", 0, { kind: "network" }), "network"],
    ["the transport deadline", new BBApiError("slow", 0, { kind: "timeout" }), "timeout"],
    ["an unparseable body", new BBApiError("bad", 0, { kind: "parse" }), "parse_error"],
    ["a 503", new BBApiError("down", 503, { kind: "http" }), "server_error"],
    // A 4xx mid-stream is not a server fault and must not be filed as one.
    ["a 404", new BBApiError("gone", 404, { kind: "http" }), "unknown"],
    // Non-BBApiError throws still classify on shape.
    ["a native AbortError", Object.assign(new Error("x"), { name: "AbortError" }), "client_abort"],
    ["bad JSON", new SyntaxError("Unexpected token"), "parse_error"],
    ["a bare fetch TypeError", new TypeError("Failed to fetch"), "network"],
    ["something unrecognised", "just a string", "unknown"],
  ];

  for (const [label, error, expected] of cases) {
    it(`files ${label} as ${expected}`, async () => {
      const { adapter, events } = makeRecorder();
      setAnalyticsAdapter(adapter);

      await drain(createMessageStream(source(["a"], error), TELEMETRY));

      const dropped = events.find(e => e.event === "stream_dropped");
      expect(dropped?.props).toEqual({ route: "chat", reason: expected });
    });
  }
});

describe("wrapStringAsStream telemetry", () => {
  it("never fabricates a ttft for an already-complete response", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    await drain(wrapStringAsStream("done", TELEMETRY));

    // A zero here would not be a fast turn, it would be a fabricated one feeding
    // the same p95 the SSE path does. A missing sample is honest; a zero is not.
    expect(events.map(e => e.event)).toEqual(["stream_started", "message_completed"]);
    expect(events.some(e => e.event === "message_first_token")).toBe(false);
  });
});

describe("ttft_ms and duration_ms mean the same thing on every route", () => {
  /**
   * `callAgenticStream` is an `async function*`, so its request round trip runs on
   * the first `next()` — inside the drain — whereas the Blocky path has already
   * awaited its request before `createMessageStream` is called. Timestamping from
   * stream creation therefore measured TTFB-inclusive latency on one route and
   * TTFB-exclusive on the other, under one metric name feeding one p95.
   */
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
  const LEG_MS = 120;

  it("reports comparable ttft for a lazy source and an already-awaited one", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    // Chat shape: the request leg is spent BEFORE the stream exists.
    const sentAt = Date.now();
    await sleep(LEG_MS);
    await drain(createMessageStream(source(["a"]), { ...TELEMETRY, startedAt: sentAt }));

    // Agent shape: the same leg is spent INSIDE the drain, by a lazy generator.
    const agentSentAt = Date.now();
    const lazy: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        await sleep(LEG_MS);
        yield "a";
      },
    };
    await drain(
      createMessageStream(lazy, { ...TELEMETRY, route: "agent", startedAt: agentSentAt }),
    );

    const ttfts = events.filter(e => e.event === "message_first_token").map(e => e.props.ttft_ms);
    expect(ttfts).toHaveLength(2);
    // Both must include the leg. Before the fix the chat one was ~1ms.
    for (const t of ttfts) expect(t).toBeGreaterThanOrEqual(LEG_MS - 20);
  });

  it("falls back to stream-creation time when the caller supplies no startedAt", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    await drain(createMessageStream(source(["a"]), TELEMETRY));

    // `createMessageStream` is a public export; an existing caller passing no
    // `startedAt` must keep working rather than get a NaN or a 1970 duration.
    expect(events.find(e => e.event === "message_first_token")?.props.ttft_ms).toEqual(
      expect.any(Number),
    );
  });
});

describe("a stream that dies before its first token is a send failure, not a drop", () => {
  it("emits message_failed{stage:send} and NO stream_dropped", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    // The agentic generator's own request 503s: nothing was ever streamed, so
    // filing this as a mid-stream drop burns the < 1% drop SLO on send failures.
    await drain(
      createMessageStream(source([], new BBApiError("down", 503, { kind: "http" })), TELEMETRY),
    );

    const names = events.map(e => e.event);
    expect(names).not.toContain("stream_dropped");
    expect(names).toContain("message_failed");
    expect(events.find(e => e.event === "message_failed")?.props).toMatchObject({
      route: "chat",
      stage: "send",
      error_code: "503",
    });
    expect(events.find(e => e.event === "message_completed")?.props).toMatchObject({
      outcome: "error",
    });
  });

  it("still reports a genuine mid-stream drop as stream_dropped", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    // A token arrived first, so the stream really did open and then break.
    await drain(
      createMessageStream(source(["a"], new BBApiError("net", 0, { kind: "network" })), TELEMETRY),
    );

    const names = events.map(e => e.event);
    expect(names).toContain("message_first_token");
    expect(names).toContain("stream_dropped");
    expect(events.find(e => e.event === "stream_dropped")?.props).toMatchObject({
      reason: "network",
    });
  });

  it("labels a pre-token cancellation as stage:cancelled", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    await drain(
      createMessageStream(source([], new BBApiError("gone", 0, { kind: "aborted" })), TELEMETRY),
    );

    expect(events.find(e => e.event === "message_failed")?.props).toMatchObject({
      stage: "cancelled",
    });
  });
});
