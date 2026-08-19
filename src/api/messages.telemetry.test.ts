import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsAdapter } from "../analytics/index.js";
import { resetAnalyticsAdapter, setAnalyticsAdapter } from "../analytics/index.js";
import type { AuthContext } from "../settings/auth-mode.js";
import { invalidateConvoDetailCache, sendMessage } from "./messages.js";

/**
 * The turn funnel, asserted on the paths a real send takes.
 *
 * The invariant under test is simple to state and was not held: **a send that
 * emitted `message_sent` must emit exactly one terminal event.** Without it a
 * failed turn is indistinguishable from a user who wandered off, so the funnel's
 * success rate reads high precisely when sends are breaking.
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

const CONVO = "convo-tel";
const CTX: AuthContext = {
  baseUrl: "https://api.example.com",
  token: "header.payload.sig",
  orgId: "org-1",
  mode: "oauth",
  userId: "user-1",
};

function jsonResponse(payload: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: new Headers(),
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  } as unknown as Response;
}

/** `sendMessage` resolves routing via `GET …/general-info`; `agent` absent = Blocky. */
const NO_AGENT = { id: CONVO };

/**
 * Stub routing to "no agent" (the Blocky path), then answer the send itself with
 * `send`. Routing must always succeed so the test exercises the send, not the lookup.
 */
function stubBlocky(send: () => Response | Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("general-info")) return Promise.resolve(jsonResponse(NO_AGENT));
      return Promise.resolve(send());
    }),
  );
}

afterEach(() => {
  resetAnalyticsAdapter();
  vi.unstubAllGlobals();
  invalidateConvoDetailCache(CONVO);
});

describe("sendMessage — the success funnel", () => {
  it("emits message_sent then message_completed for a non-streaming Blocky send", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    stubBlocky(() => jsonResponse({ body: { content: "hello" } }));

    await sendMessage(CTX, CONVO, "hi");

    expect(events.map(e => e.event)).toEqual(["message_sent", "message_completed"]);
    const [sent, completed] = events;
    expect(sent.props).toMatchObject({ conversation_id: CONVO, route: "chat" });
    expect(sent.props.message_id).toEqual(expect.any(String));
    expect(completed.props).toMatchObject({ route: "chat", outcome: "success" });
    // The id minted for the send correlates the terminal event back to it.
    expect(completed.props.request_id).toBe(sent.props.message_id);
  });

  it("never puts the message text in any event", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    stubBlocky(() => jsonResponse({ body: { content: "hello" } }));

    await sendMessage(CTX, CONVO, "my salary is a secret");

    expect(JSON.stringify(events)).not.toContain("salary");
    // `input_mode` must be absent, not defaulted — only the surface knows whether
    // this string was typed or dictated, and "text" would report every dictation
    // as typing.
    expect(events[0].props).not.toHaveProperty("input_mode");
  });
});

describe("sendMessage — every failure closes the funnel", () => {
  it("emits message_failed{stage:send} + message_completed{outcome:error} on a non-2xx", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    stubBlocky(() => jsonResponse({ error: "nope" }, { ok: false, status: 503 }));

    await expect(sendMessage(CTX, CONVO, "hi")).rejects.toThrow();

    const names = events.map(e => e.event);
    expect(names).toContain("message_sent");
    expect(names).toContain("message_failed");
    const failed = events.find(e => e.event === "message_failed");
    expect(failed?.props).toMatchObject({ route: "chat", stage: "send", error_code: "503" });
    const completed = events.find(e => e.event === "message_completed");
    expect(completed?.props).toMatchObject({ route: "chat", outcome: "error" });
  });

  it("reports a malformed 2xx payload as stage:parse, not stage:send", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    // 200 with no `body.content` — the server answered, the shape was wrong.
    stubBlocky(() => jsonResponse({ body: {} }));

    await expect(sendMessage(CTX, CONVO, "hi")).rejects.toThrow();

    const failed = events.find(e => e.event === "message_failed");
    expect(failed?.props).toMatchObject({ stage: "parse" });
  });

  it("reports a caller abort as stage:cancelled so it can be excluded from error rate", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    stubBlocky(() => {
      // A real `fetch` rejection for a cancelled request. `toTransportError` is what
      // turns this into `BBApiError{statusCode: 0, kind: "aborted"}`, so the test
      // exercises the actual conversion rather than a hand-made error shape.
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    });

    await expect(sendMessage(CTX, CONVO, "hi")).rejects.toThrow();

    const failed = events.find(e => e.event === "message_failed");
    // A user navigating away is not a reliability defect; `stage` is what lets a
    // dashboard say so, since `outcome` is only success|error.
    expect(failed?.props).toMatchObject({ stage: "cancelled", error_code: "aborted" });
  });

  it("emits exactly one terminal event per send, never two", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    stubBlocky(() => jsonResponse({ error: "nope" }, { ok: false, status: 500 }));

    await expect(sendMessage(CTX, CONVO, "hi")).rejects.toThrow();

    expect(events.filter(e => e.event === "message_completed")).toHaveLength(1);
    expect(events.filter(e => e.event === "message_sent")).toHaveLength(1);
  });

  it("re-throws the original error unchanged — telemetry observes, it does not absorb", async () => {
    const { adapter } = makeRecorder();
    setAnalyticsAdapter(adapter);
    stubBlocky(() => jsonResponse({ error: "nope" }, { ok: false, status: 503 }));

    await expect(sendMessage(CTX, CONVO, "hi")).rejects.toMatchObject({ statusCode: 503 });
  });

  it("emits no terminal event when routing itself fails, because no send began", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({}, { ok: false, status: 500 }))),
    );

    await expect(sendMessage(CTX, CONVO, "hi")).rejects.toThrow();

    // `message_sent` never fired, so there is nothing to close. Emitting a
    // terminal event here would invent a turn that was never attempted.
    expect(events.map(e => e.event)).not.toContain("message_sent");
    expect(events.map(e => e.event)).not.toContain("message_completed");
  });
});

describe("sendMessage — the agent route", () => {
  const AGENT = "agent-tel";

  /** Routing says this conversation HAS an agent, so sendMessage takes the agentic path. */
  function stubAgentRouting(agenticReply: () => Response | Promise<Response>): void {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("general-info")) {
          return Promise.resolve(jsonResponse({ id: CONVO, agent: AGENT }));
        }
        return Promise.resolve(agenticReply());
      }),
    );
  }

  /** An SSE body carrying text-deltas then the terminator. */
  function sseResponse(frames: object[]): Response {
    const text = `${frames.map(f => `data: ${JSON.stringify(f)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      }),
    } as unknown as Response;
  }

  it("emits route:agent, not route:chat", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    stubAgentRouting(() => sseResponse([{ type: "text-delta", textDelta: "hi" }]));

    await sendMessage(CTX, CONVO, "hello");

    expect(events[0].event).toBe("message_sent");
    expect(events[0].props.route).toBe("agent");
  });

  it("labels a REFUSED agentic send as stage:send, not stage:stream", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    // The agentic endpoint 503s. Because `callAgenticStream` is a lazy generator the
    // request is issued by the first loop iteration, so a naive `stage = "stream"`
    // before the loop would blame the stream for a send that was refused.
    stubAgentRouting(() => jsonResponse({ error: "down" }, { ok: false, status: 503 }));

    await expect(sendMessage(CTX, CONVO, "hello")).rejects.toThrow();

    const failed = events.find(e => e.event === "message_failed");
    expect(failed?.props).toMatchObject({ route: "agent", stage: "send" });
  });

  it("closes the funnel exactly once on the buffered agentic path", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    stubAgentRouting(() => sseResponse([{ type: "text-delta", textDelta: "a" }]));

    await sendMessage(CTX, CONVO, "hello");

    expect(events.filter(e => e.event === "message_completed")).toHaveLength(1);
    expect(events.find(e => e.event === "message_completed")?.props).toMatchObject({
      route: "agent",
      outcome: "success",
    });
  });

  it("a streaming agentic turn is closed by the stream, never twice", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    stubAgentRouting(() => sseResponse([{ type: "text-delta", textDelta: "a" }]));

    const stream = await sendMessage(CTX, CONVO, "hello", { enableStreaming: true });
    if (typeof stream === "string") throw new Error("expected a MessageStream");
    await stream.final;

    // `sendMessage` returns before the stream finishes, so its catch must not also
    // fire — exactly one terminal event for the turn.
    expect(events.filter(e => e.event === "message_completed")).toHaveLength(1);
    expect(events.map(e => e.event)).toEqual([
      "message_sent",
      "stream_started",
      "message_first_token",
      "message_completed",
    ]);
  });

  it("ttft_ms on a streaming agentic turn includes the request leg the lazy source pays", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    stubAgentRouting(
      () =>
        new Promise<Response>(resolve => {
          setTimeout(() => resolve(sseResponse([{ type: "text-delta", textDelta: "a" }])), 60);
        }),
    );

    const stream = await sendMessage(CTX, CONVO, "hello", { enableStreaming: true });
    if (typeof stream === "string") throw new Error("expected a MessageStream");
    await stream.final;

    const ttft = events.find(e => e.event === "message_first_token")?.props.ttft_ms as number;
    expect(ttft).toBeGreaterThanOrEqual(50);
  });
});

describe("ttft_ms is measured from the SEND on the chat route too", () => {
  /**
   * The test that actually pins the `startedAt` wiring.
   *
   * The agent-route case cannot: `callAgenticStream` is lazy, so its request leg sits
   * inside the drain and `ttft_ms` includes it whether or not `sendMessage` passes a
   * baseline. Only the Blocky path — which awaits its response BEFORE building the
   * stream — collapses to ~0 when the baseline is missing, which is precisely the
   * asymmetry that made one metric mean two things.
   */
  const BLOCKY_LEG_MS = 60;

  function blockySseResponse(): Response {
    const frames =
      'event: new_token\r\ndata: {"role":"assistant","token":"hi","gid":"g1"}\r\n\r\n' +
      'event: message_ready\r\ndata: {"messageIds":["m1"]}\r\n\r\n';
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frames));
          controller.close();
        },
      }),
    } as unknown as Response;
  }

  it("includes the Blocky request leg, which finishes before the stream is built", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("general-info")) return Promise.resolve(jsonResponse(NO_AGENT));
        return new Promise<Response>(resolve => {
          setTimeout(() => resolve(blockySseResponse()), BLOCKY_LEG_MS);
        });
      }),
    );

    const stream = await sendMessage(CTX, CONVO, "hi", { enableStreaming: true });
    if (typeof stream === "string") throw new Error("expected a MessageStream");
    await stream.final;

    const first = events.find(e => e.event === "message_first_token");
    expect(first?.props.route).toBe("chat");
    // Without the baseline this is ~0, because `request()` already resolved.
    expect(first?.props.ttft_ms as number).toBeGreaterThanOrEqual(BLOCKY_LEG_MS - 15);
  });
});
