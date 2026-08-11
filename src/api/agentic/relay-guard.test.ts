import { describe, expect, it, vi } from "vitest";
import type { Transporter, TransportRequest, TransportResponse } from "../transport.js";
import {
  assertRelayOnTheWire,
  bodyDeclaresRelay,
  isRelayNotOnTheWireError,
  RelayNotOnTheWireError,
} from "./relay-guard.js";

const STREAM_PATH = "/v2/api/agents/word-agent/stream";

const OK: TransportResponse = {
  status: 200,
  ok: true,
  headers: {},
  json: <T>() => Promise.resolve({} as T),
  text: () => Promise.resolve(""),
};

function innerTransport(): { transport: Transporter; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(() => Promise.resolve(OK));
  return { transport: { send }, send };
}

/** A request the guard should let through, unless a field is overridden. */
function streamRequest(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    host: "agentic",
    path: STREAM_PATH,
    method: "POST",
    body: JSON.stringify({
      id: "req-1",
      messages: [],
      externalTools: [{ name: "propose_edits", description: "", parameters: {} }],
    }),
    ...overrides,
  };
}

describe("bodyDeclaresRelay", () => {
  it("accepts a body with at least one tool", () => {
    expect(bodyDeclaresRelay(JSON.stringify({ externalTools: [{ name: "a" }] }))).toBe(true);
  });

  // The client omits `externalTools` from the body when the array is empty, so
  // an empty array reaches the server as no relay at all — the same stalled turn
  // as a missing field, and therefore the same answer.
  it("treats an empty array as no relay", () => {
    expect(bodyDeclaresRelay(JSON.stringify({ externalTools: [] }))).toBe(false);
  });

  // The guard's whole value is that it has no quiet path: anything it cannot
  // read is "missing", never "probably fine".
  it("treats anything it cannot read as missing", () => {
    expect(bodyDeclaresRelay(undefined)).toBe(false);
    expect(bodyDeclaresRelay(new FormData())).toBe(false);
    expect(bodyDeclaresRelay("not json at all")).toBe(false);
    expect(bodyDeclaresRelay("null")).toBe(false);
    expect(bodyDeclaresRelay('"a string body"')).toBe(false);
    expect(bodyDeclaresRelay(JSON.stringify({ messages: [] }))).toBe(false);
    // Present but not an array — a shape the server cannot build a toolset from.
    expect(bodyDeclaresRelay(JSON.stringify({ externalTools: { name: "a" } }))).toBe(false);
  });
});

describe("assertRelayOnTheWire", () => {
  it("passes a declared relay through to the inner transport untouched", async () => {
    const { transport, send } = innerTransport();
    const req = streamRequest();

    await expect(assertRelayOnTheWire(transport).send(req)).resolves.toBe(OK);
    expect(send).toHaveBeenCalledExactlyOnceWith(req);
  });

  // Nothing is sent: no run is created and no tokens are burned. Asserting the
  // inner transport was never called is the point of the test, not the throw.
  it("refuses a stream POST with no relay, without sending it", async () => {
    const { transport, send } = innerTransport();
    const req = streamRequest({ body: JSON.stringify({ id: "req-1", messages: [] }) });

    await expect(assertRelayOnTheWire(transport).send(req)).rejects.toBeInstanceOf(
      RelayNotOnTheWireError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  // `Transporter.send` promises a promise, and a caller may hold only a
  // `.catch`. A synchronous throw would escape that and crash the turn where a
  // rejection is handled.
  it("rejects rather than throwing synchronously", () => {
    const { transport } = innerTransport();
    const req = streamRequest({ body: undefined });

    const result = assertRelayOnTheWire(transport).send(req);

    expect(result).toBeInstanceOf(Promise);
    return expect(result).rejects.toBeInstanceOf(RelayNotOnTheWireError);
  });

  it("names the path and never the body", async () => {
    const { transport } = innerTransport();
    const secret = "the user's document text";
    const req = streamRequest({ body: JSON.stringify({ messages: [{ content: secret }] }) });

    // The message is rendered, logged and forwarded to Sentry verbatim, so the
    // body must not be in it.
    const err = await assertRelayOnTheWire(transport)
      .send(req)
      .catch((caught: unknown) => caught);

    expect(isRelayNotOnTheWireError(err)).toBe(true);
    expect((err as RelayNotOnTheWireError).path).toBe(STREAM_PATH);
    expect((err as Error).message).toContain(STREAM_PATH);
    expect((err as Error).message).not.toContain(secret);
  });

  // One wrapped transporter serves the whole surface, so every request that is
  // not the relay-carrying one has to pass untouched.
  it("leaves every other request alone", async () => {
    const { transport, send } = innerTransport();
    const guarded = assertRelayOnTheWire(transport);

    const others: TransportRequest[] = [
      // Not a POST: the resume path GETs nothing, but a HEAD or GET on the same
      // path must not be refused for lacking a body it never had.
      streamRequest({ method: "GET", body: undefined }),
      // A different route entirely, with no relay in sight.
      { host: "blocky", path: "/cortex/conversation/abc", method: "POST", body: "{}" },
      // Adjacent paths that the route regex must not swallow.
      streamRequest({ path: "/v2/api/agents/word-agent", body: undefined }),
      streamRequest({ path: "/v2/api/agents/word-agent/stream/extra", body: undefined }),
      streamRequest({ path: "/v2/api/agents", body: undefined }),
    ];

    for (const req of others) await expect(guarded.send(req)).resolves.toBe(OK);
    expect(send).toHaveBeenCalledTimes(others.length);
  });

  // An agent id is user-visible and gets URL-encoded, so the segment can carry
  // escapes. It must still be recognised as the stream route.
  it("matches the stream route whatever the agent id looks like", async () => {
    const { transport, send } = innerTransport();
    const req = streamRequest({
      path: "/v2/api/agents/agent%20one%2Ftwo/stream",
      body: undefined,
    });

    await expect(assertRelayOnTheWire(transport).send(req)).rejects.toBeInstanceOf(
      RelayNotOnTheWireError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  // A resume request is where the relay is most often lost: the server rebuilds
  // the toolset per request, so a resume body that dropped the field strands the
  // suspended run.
  it("refuses a resume request that dropped the tools", async () => {
    const { transport, send } = innerTransport();
    const resume = streamRequest({
      body: JSON.stringify({ id: "req-1", messages: [], resumeData: { type: "external-tool" } }),
    });

    await expect(assertRelayOnTheWire(transport).send(resume)).rejects.toBeInstanceOf(
      RelayNotOnTheWireError,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("does not claim unrelated errors", () => {
    expect(isRelayNotOnTheWireError(new Error("something else"))).toBe(false);
    expect(isRelayNotOnTheWireError(null)).toBe(false);
  });
});
