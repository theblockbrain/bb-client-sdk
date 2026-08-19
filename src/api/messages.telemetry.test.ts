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

/** `sendMessage` first resolves routing via `GET …/general-info`. */
const NO_AGENT = { body: { agentId: null } };

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
