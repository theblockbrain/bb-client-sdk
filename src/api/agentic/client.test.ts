import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageStream } from "../stream-result.js";
import type { ExternalToolExecutor } from "./client.js";
import { autoApproveResolver, callAgenticStream, denyAllResolver } from "./client.js";
import type { AgenticStreamError } from "./errors.js";
import { isAgenticStreamError } from "./errors.js";

/**
 * Regression tests for PDEV-7330 — the SDK must never answer a tool-call
 * approval gate on the user's behalf.
 *
 * The backend emits `data-tool-call-approval` and WAITS for
 * `resumeData {approved}` plus the `runId`. These tests drive the real resume
 * loop with a stubbed `fetch` and assert on the body of the SECOND request —
 * the resume — because that body is what decides whether a server-side tool
 * executes against live data.
 */

/** Build an SSE response body from frame objects, in the wire shape sse.ts parses. */
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

const APPROVAL_FRAME = {
  type: "data-tool-call-approval",
  data: { runId: "run-1", toolCallId: "call-1", toolName: "sendEmail" },
};
const SUSPEND_FRAME = {
  type: "data-tool-call-suspended",
  data: { runId: "run-2", toolCallId: "call-2" },
};

const OPTIONS = {
  token: "t",
  orgId: "org-1",
  agentId: "agent-1",
  convoId: "convo-1",
  userId: "user-1",
  content: "send it",
};

/**
 * Stub fetch so turn 1 emits `frames` and turn 2 (the resume) just answers.
 * Returns the recorded request bodies.
 */
function stubTurns(frames: object[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchMock = vi.fn((_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return Promise.resolve(
      bodies.length === 1
        ? sseResponse(frames)
        : sseResponse([{ type: "text-delta", textDelta: "done" }]),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return bodies;
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("callAgenticStream — tool-call approval (PDEV-7330)", () => {
  it("denyAllResolver refuses the tool call — resumes with approved:false", async () => {
    const bodies = stubTurns([APPROVAL_FRAME]);

    await drain(callAgenticStream({ ...OPTIONS, approvalResolver: denyAllResolver }));

    expect(bodies).toHaveLength(2);
    expect(bodies[1].runId).toBe("run-1");
    expect(bodies[1].resumeData).toEqual({ approved: false });
    // The exact defect PDEV-7330 fixed: this must never appear unasked.
    expect(JSON.stringify(bodies[1])).not.toContain('"approved":true');
  });

  it("autoApproveResolver still works as an EXPLICIT opt-in", async () => {
    const bodies = stubTurns([APPROVAL_FRAME]);

    await drain(callAgenticStream({ ...OPTIONS, approvalResolver: autoApproveResolver }));

    expect(bodies[1].resumeData).toEqual({ approved: true });
  });

  it("a caller's resolver receives the frame's context and decides per call", async () => {
    const bodies = stubTurns([APPROVAL_FRAME]);
    const seen: unknown[] = [];

    await drain(
      callAgenticStream({
        ...OPTIONS,
        approvalResolver: {
          resolveApproval: ctx => {
            seen.push(ctx);
            // A real UI decides here; approve only the tool it recognises.
            return Promise.resolve({ approved: ctx.toolName === "readInbox" });
          },
          resolveSuspend: () => Promise.resolve({ cancelled: true }),
        },
      }),
    );

    expect(seen).toEqual([{ runId: "run-1", toolCallId: "call-1", toolName: "sendEmail" }]);
    // toolName was sendEmail, not readInbox → refused.
    expect(bodies[1].resumeData).toEqual({ approved: false });
  });

  it("denyAllResolver cancels a suspend instead of fabricating an answer", async () => {
    const bodies = stubTurns([SUSPEND_FRAME]);

    await drain(callAgenticStream({ ...OPTIONS, approvalResolver: denyAllResolver }));

    expect(bodies[1].resumeData).toEqual({ __cancelled: true });
    // An empty `answers` object would let the agent proceed as if a human replied.
    expect(JSON.stringify(bodies[1])).not.toContain('"answers"');
  });

  it("text deltas still stream through while an approval is pending", async () => {
    stubTurns([{ type: "text-delta", textDelta: "thinking… " }, APPROVAL_FRAME]);

    const text = await drain(callAgenticStream({ ...OPTIONS, approvalResolver: denyAllResolver }));

    // Turn 1's prose plus turn 2's — a denied tool must not swallow the answer.
    expect(text).toBe("thinking… done");
  });
});

/**
 * PDEV-7333 — the frames the SDK never handled, and the ends it used to take
 * silently.
 *
 * Every terminal case below used to be a bare `break`, which returned the text
 * accumulated so far as though the turn had finished. `useChatStream` then wrote
 * that half-answer into the message cache as the assistant's reply. These tests
 * pin the distinction: an incomplete turn throws.
 */

const TOO_LARGE_FRAME = {
  type: "data-tool-call-too-large",
  data: { toolName: "createTicket" },
};
const SERVER_ERROR_FRAME = {
  type: "data-error",
  data: {
    code: "TOOL_EXECUTION_FAILED",
    errorClass: "MastraError",
    message: "Graph call failed",
    traceId: "trace-42",
    retryable: true,
    partial: false,
  },
};

/** Stub fetch with one response per POST, in order — for multi-turn resume tests. */
function stubSequence(...turns: object[][]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const frames of turns) fetchMock.mockResolvedValueOnce(sseResponse(frames));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Run the stream to completion and return whatever it threw, or null. */
async function thrownBy(stream: AsyncIterable<string>): Promise<unknown> {
  return drain(stream).then(
    () => null,
    (err: unknown) => err,
  );
}

const DENY = { ...OPTIONS, approvalResolver: denyAllResolver };

describe("callAgenticStream — fail-fast frames (PDEV-7333)", () => {
  describe("data-tool-call-too-large", () => {
    it("throws instead of returning a truncated turn", async () => {
      stubSequence([{ type: "text-delta", textDelta: "partial" }, TOO_LARGE_FRAME]);

      const err = await thrownBy(callAgenticStream(DENY));

      expect(isAgenticStreamError(err)).toBe(true);
      const streamError = err as AgenticStreamError;
      expect(streamError.reason).toBe("tool-call-too-large");
      expect(streamError.toolName).toBe("createTicket");
      expect(streamError.partial).toBe(true);
    });

    it("does NOT auto-resume", async () => {
      // The point of the server-side fail-fast: resuming regenerates the same
      // oversized call and burns the budget for nothing.
      const fetchMock = stubSequence([TOO_LARGE_FRAME]);

      await thrownBy(callAgenticStream(DENY));

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("wins over an approval frame in the same stream", async () => {
      // The server emits it right before `finish`, so both can arrive in one
      // stream. Resuming on the approval walks straight into the wall.
      const fetchMock = stubSequence([APPROVAL_FRAME, TOO_LARGE_FRAME], []);

      const err = await thrownBy(callAgenticStream(DENY));

      expect((err as AgenticStreamError).reason).toBe("tool-call-too-large");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("data-error", () => {
    it("throws with the server's classification attached", async () => {
      stubSequence([SERVER_ERROR_FRAME]);

      const err = await thrownBy(callAgenticStream(DENY));

      expect(isAgenticStreamError(err)).toBe(true);
      const streamError = err as AgenticStreamError;
      expect(streamError.reason).toBe("server-error");
      expect(streamError.code).toBe("TOOL_EXECUTION_FAILED");
      expect(streamError.traceId).toBe("trace-42");
      expect(streamError.retryable).toBe(true);
      expect(streamError.message).toContain("Graph call failed");
    });

    it("does not resume", async () => {
      const fetchMock = stubSequence([APPROVAL_FRAME, SERVER_ERROR_FRAME], []);

      await thrownBy(callAgenticStream(DENY));

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("passes through a code the SDK has never heard of", async () => {
      // `AgenticErrorCode` lists what the server sends *today*; the SDK releases
      // independently of it. A code typed as the closed union would let a
      // consumer's `switch` claim exhaustiveness, so the wire-facing fields use
      // the open `AgenticErrorCodeValue` and an unknown code reaches the caller
      // intact rather than being dropped or coerced.
      stubSequence([
        {
          type: "data-error",
          data: {
            code: "RATE_LIMITED",
            errorClass: "TooManyRequests",
            message: "slow down",
            traceId: "t-9",
            retryable: true,
            partial: false,
          },
        },
      ]);

      const err = await thrownBy(callAgenticStream(DENY));

      expect((err as AgenticStreamError).code).toBe("RATE_LIMITED");
      expect((err as AgenticStreamError).retryable).toBe(true);
    });
  });

  describe("the resume budget", () => {
    it("throws a distinguishable terminal error when exhausted", async () => {
      stubSequence(
        [{ type: "text-delta", textDelta: "a" }, APPROVAL_FRAME],
        [{ type: "text-delta", textDelta: "b" }, APPROVAL_FRAME],
        [{ type: "text-delta", textDelta: "c" }, APPROVAL_FRAME],
      );

      const err = await thrownBy(callAgenticStream({ ...DENY, maxAutoResumes: 2 }));

      expect(isAgenticStreamError(err)).toBe(true);
      expect((err as AgenticStreamError).reason).toBe("resume-budget-exhausted");
      // Text did reach the caller before the turn died — a surface may prefer to
      // keep what it rendered rather than discard it.
      expect((err as AgenticStreamError).partial).toBe(true);
    });

    it("throws on an exhausted suspend budget too", async () => {
      stubSequence([SUSPEND_FRAME], [SUSPEND_FRAME]);

      const err = await thrownBy(callAgenticStream({ ...DENY, maxAutoResumes: 1 }));

      expect((err as AgenticStreamError).reason).toBe("resume-budget-exhausted");
      expect((err as AgenticStreamError).partial).toBe(false);
    });

    it("stops at exactly maxAutoResumes resumes plus the initial POST", async () => {
      const fetchMock = stubSequence([APPROVAL_FRAME], [APPROVAL_FRAME], [APPROVAL_FRAME]);

      await thrownBy(callAgenticStream({ ...DENY, maxAutoResumes: 2 }));

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("the MessageStream contract", () => {
    it("rejects `final` on a truncated turn instead of resolving partial text", async () => {
      // The link in the chain that makes the hook test meaningful: the client
      // throwing only prevents a bad commit if createMessageStream turns it into
      // a rejected `final`. Before this ticket the turn ended with `break`, so
      // `final` RESOLVED with "half an answer" and every consumer treated it as
      // the assistant's complete reply.
      stubSequence([{ type: "text-delta", textDelta: "half an answer" }, TOO_LARGE_FRAME]);

      const stream = createMessageStream(callAgenticStream(DENY));

      await expect(stream.final).rejects.toThrow(/ran out of output tokens/);
      await expect(stream.final).rejects.toMatchObject({ reason: "tool-call-too-large" });
    });

    it("re-throws into textDeltas so a delta-only consumer also sees the failure", async () => {
      stubSequence([{ type: "text-delta", textDelta: "half" }, TOO_LARGE_FRAME]);

      const stream = createMessageStream(callAgenticStream(DENY));
      const seen: string[] = [];
      const err = await (async () => {
        try {
          for await (const delta of stream.textDeltas) seen.push(delta);
          return null;
        } catch (e: unknown) {
          return e;
        }
      })();

      // The text still arrived — it is the *commit* that must not happen.
      expect(seen).toEqual(["half"]);
      expect(isAgenticStreamError(err)).toBe(true);
    });
  });

  describe("non-terminal observations", () => {
    it("reports a failed tool call without ending the turn", async () => {
      stubSequence([
        { type: "tool-output-error", toolCallId: "t9", error: { message: "403 from Graph" } },
        { type: "text-delta", textDelta: "I could not read that mailbox." },
      ]);
      const onToolError = vi.fn();

      const text = await drain(callAgenticStream({ ...DENY, onToolError }));

      expect(text).toBe("I could not read that mailbox.");
      expect(onToolError).toHaveBeenCalledWith({
        toolCallId: "t9",
        error: { message: "403 from Graph" },
      });
    });

    it("reports a missing integration so the surface can render a Connect card", async () => {
      stubSequence([
        {
          type: "data-connect-integration",
          id: "connect:t1:sharepoint_microsoft-tenant",
          data: { providerKey: "sharepoint_microsoft-tenant", toolId: "listFiles" },
        },
        { type: "text-delta", textDelta: "Connect SharePoint to continue." },
      ]);
      const onConnectIntegration = vi.fn();

      const text = await drain(callAgenticStream({ ...DENY, onConnectIntegration }));

      expect(text).toBe("Connect SharePoint to continue.");
      expect(onConnectIntegration).toHaveBeenCalledWith({
        providerKey: "sharepoint_microsoft-tenant",
        toolId: "listFiles",
      });
    });

    it("survives an observer that throws", async () => {
      // An observer is a notification, not control flow. A bug in a Connect card
      // renderer must not abort an agent run that is still producing an answer.
      stubSequence([
        { type: "tool-output-error", toolCallId: "t9" },
        { type: "data-connect-integration", data: { providerKey: "p", toolId: "t" } },
        { type: "text-delta", textDelta: "answer survived" },
      ]);

      const text = await drain(
        callAgenticStream({
          ...DENY,
          onToolError: () => {
            throw new Error("renderer blew up");
          },
          onConnectIntegration: () => {
            throw new Error("card blew up");
          },
        }),
      );

      expect(text).toBe("answer survived");
    });

    it("tolerates a malformed connect-integration frame with no data", async () => {
      stubSequence([{ type: "data-connect-integration" }, { type: "text-delta", textDelta: "ok" }]);
      const onConnectIntegration = vi.fn();

      await expect(drain(callAgenticStream({ ...DENY, onConnectIntegration }))).resolves.toBe("ok");
      expect(onConnectIntegration).not.toHaveBeenCalled();
    });

    it("ignores both frames when no callback is supplied", async () => {
      stubSequence([
        { type: "tool-output-error", toolCallId: "t9" },
        { type: "data-connect-integration", data: { providerKey: "p", toolId: "t" } },
        { type: "text-delta", textDelta: "still fine" },
      ]);

      await expect(drain(callAgenticStream(DENY))).resolves.toBe("still fine");
    });
  });
});

/**
 * PDEV-7920 — the client-executed tool relay.
 *
 * A `data-tool-call-suspended` frame means one of two different things, and the
 * frame type alone does not say which: "run this tool for me" when the tool is one
 * the caller declared in `externalTools`, or "ask the user this" otherwise. These
 * tests pin the dispatch and the resume body, because the resume body is what
 * decides whether the suspended run can continue at all.
 */
describe("callAgenticStream — external tool relay (PDEV-7920)", () => {
  const WORD_TOOL = {
    name: "propose_edits",
    description: "Propose tracked changes for the open document",
    parameters: { type: "object", properties: { edits: { type: "array" } } },
  };

  /** Frames for one relayed call: the args, then the suspend naming the tool. */
  const relayTurn = (input: unknown, toolCallId = "call-w1", runId = "run-w1") => [
    { type: "tool-input-available", toolCallId, toolName: WORD_TOOL.name, input },
    { type: "data-tool-call-suspended", data: { runId, toolCallId, toolName: WORD_TOOL.name } },
  ];

  const relayOptions = (executeExternalTool: ExternalToolExecutor) => ({
    ...OPTIONS,
    approvalResolver: denyAllResolver,
    externalTools: [WORD_TOOL],
    executeExternalTool,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stops between steps when the caller aborts while a tool is running", async () => {
    // The signal reaches each POST, so an abort DURING a request was already
    // observed. Between steps it was not: a turn cancelled while a relayed tool
    // ran let that tool finish and then issued a fresh resume POST carrying its
    // result. Relayed tools run on the client and can take seconds, so the window
    // is wide, and from the surface's side a cancelled turn kept talking to the
    // server.
    const controller = new AbortController();
    const bodies = stubTurns(relayTurn({ edits: [] }));
    const execute = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { applied: 0 };
    });

    await expect(
      drain(callAgenticStream({ ...relayOptions(execute), signal: controller.signal })),
    ).rejects.toMatchObject({ kind: "aborted" });

    // The tool ran (it was already in flight), but no resume was sent after it.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(1);
  });

  it("does not abort a turn whose signal never fired", async () => {
    const controller = new AbortController();
    const bodies = stubTurns(relayTurn({ edits: [] }));
    const execute = vi.fn().mockResolvedValue({ applied: 1 });

    const text = await drain(
      callAgenticStream({ ...relayOptions(execute), signal: controller.signal }),
    );

    expect(text).toBe("done");
    expect(bodies).toHaveLength(2);
  });

  it("runs the named tool and resumes with its result", async () => {
    const bodies = stubTurns(relayTurn({ edits: [{ original: "a", modified: "b" }] }));
    const execute = vi.fn().mockResolvedValue({ applied: 1 });

    const text = await drain(callAgenticStream(relayOptions(execute)));

    expect(text).toBe("done");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      toolName: "propose_edits",
      toolCallId: "call-w1",
      runId: "run-w1",
      input: { edits: [{ original: "a", modified: "b" }] },
    });
    expect(bodies[1]).toMatchObject({ runId: "run-w1", resumeData: { applied: 1 } });
  });

  // The server rebuilds the relay tool per request, so a resume that drops
  // externalTools strands the run it is trying to resume.
  it("re-sends externalTools on the resume, not just the initial request", async () => {
    const bodies = stubTurns(relayTurn({}));

    await drain(callAgenticStream(relayOptions(() => Promise.resolve({ ok: true }))));

    expect(bodies[0]?.externalTools).toEqual([WORD_TOOL]);
    expect(bodies[1]?.externalTools).toEqual([WORD_TOOL]);
  });

  it("re-sends externalTools on an approval resume too", async () => {
    const bodies = stubTurns([APPROVAL_FRAME]);

    await drain(callAgenticStream(relayOptions(() => Promise.resolve({}))));

    expect(bodies[1]).toMatchObject({ runId: "run-1", resumeData: { approved: false } });
    expect(bodies[1]?.externalTools).toEqual([WORD_TOOL]);
  });

  // A suspend for a tool the caller never declared is an ask-user-question. Routing
  // it to the executor would run an arbitrary server-named tool locally.
  it("routes an unrecognised toolName to the approval resolver, not the executor", async () => {
    const bodies = stubTurns([
      { type: "data-tool-call-suspended", data: { runId: "run-q", toolName: "askUserQuestion" } },
    ]);
    const execute = vi.fn();

    await drain(callAgenticStream(relayOptions(execute)));

    expect(execute).not.toHaveBeenCalled();
    expect(bodies[1]).toMatchObject({ resumeData: { __cancelled: true } });
  });

  it("routes a suspend with no toolName to the approval resolver", async () => {
    const bodies = stubTurns([SUSPEND_FRAME]);
    const execute = vi.fn();

    await drain(callAgenticStream(relayOptions(execute)));

    expect(execute).not.toHaveBeenCalled();
    expect(bodies[1]).toMatchObject({ resumeData: { __cancelled: true } });
  });

  // Declaring tools without supplying an executor cannot complete a relay. Treating
  // it as an ask-user-question is the honest fallback — the alternative is calling
  // undefined mid-turn.
  it("falls back to the resolver when externalTools are declared with no executor", async () => {
    const bodies = stubTurns(relayTurn({}));

    await drain(
      callAgenticStream({
        ...OPTIONS,
        approvalResolver: denyAllResolver,
        externalTools: [WORD_TOOL],
      }),
    );

    expect(bodies[1]).toMatchObject({ resumeData: { __cancelled: true } });
  });

  // The run is suspended server-side. Throwing here abandons it and costs the user a
  // whole turn because one tool failed; telling the model lets it recover.
  it("resumes with an error payload when the tool throws, instead of killing the turn", async () => {
    const bodies = stubTurns(relayTurn({}));
    const execute = vi.fn().mockRejectedValue(new Error("Word.run failed: document locked"));

    const text = await drain(callAgenticStream(relayOptions(execute)));

    expect(text).toBe("done");
    expect(bodies[1]?.resumeData).toEqual({ error: "Word.run failed: document locked" });
  });

  // Nothing on either side of the wire orders `tool-input-available` before the
  // suspend, and the arguments are on the suspend too: the server's relay tool calls
  // `suspend(args)` (botticelli external-toolset.ts) and Mastra surfaces that as
  // `suspendPayload`. Reading only the frame map made the whole relay depend on an
  // ordering nobody guarantees, and its failure was silent and total: every
  // argument-taking tool ran with `undefined`, so the model was told its tool failed
  // and narrated prose instead of editing the document.
  it("falls back to suspendPayload when no tool-input-available frame arrived", async () => {
    stubTurns([
      {
        type: "data-tool-call-suspended",
        data: {
          runId: "r",
          toolCallId: "c",
          toolName: WORD_TOOL.name,
          suspendPayload: { edits: [{ original: "a", modified: "b" }] },
        },
      },
    ]);
    const execute = vi.fn().mockResolvedValue({});

    await drain(callAgenticStream(relayOptions(execute)));

    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      input: { edits: [{ original: "a", modified: "b" }] },
    });
  });

  // The fallback must not depend on the id it is keyed by: a suspend that names no
  // toolCallId skips the map lookup entirely and still has to reach the payload.
  it("falls back to suspendPayload even when the suspend carries no toolCallId", async () => {
    stubTurns([
      {
        type: "data-tool-call-suspended",
        data: { runId: "r", toolName: WORD_TOOL.name, suspendPayload: { edits: ["only-payload"] } },
      },
    ]);
    const execute = vi.fn().mockResolvedValue({});

    await drain(callAgenticStream(relayOptions(execute)));

    expect(execute.mock.calls[0]?.[0]).toMatchObject({ input: { edits: ["only-payload"] } });
  });

  // The frame stays the more specific source: it is keyed by this exact tool call,
  // so the fallback is additive and cannot change what a working relay already sees.
  it("prefers the tool-input-available value when both sources are present", async () => {
    stubTurns([
      {
        type: "tool-input-available",
        toolCallId: "c",
        toolName: WORD_TOOL.name,
        input: { edits: ["from-frame"] },
      },
      {
        type: "data-tool-call-suspended",
        data: {
          runId: "r",
          toolCallId: "c",
          toolName: WORD_TOOL.name,
          suspendPayload: { edits: ["from-payload"] },
        },
      },
    ]);
    const execute = vi.fn().mockResolvedValue({});

    await drain(callAgenticStream(relayOptions(execute)));

    expect(execute.mock.calls[0]?.[0]).toMatchObject({ input: { edits: ["from-frame"] } });
  });

  it("passes input: undefined when neither source carried arguments", async () => {
    stubTurns([
      {
        type: "data-tool-call-suspended",
        data: { runId: "r", toolCallId: "c", toolName: WORD_TOOL.name },
      },
    ]);
    const execute = vi.fn().mockResolvedValue({});

    await drain(callAgenticStream(relayOptions(execute)));

    // "No arguments observed", not "no arguments passed" — the executor decides what
    // to do about it, and failing beats guessing.
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ input: undefined });
  });

  // The whole point of the separate budget: a document edit is a read-then-propose
  // loop, and charging each step to the 3-resume unattended-decision budget would
  // end routine turns half-finished.
  it("does not spend the maxAutoResumes budget on relayed tool calls", async () => {
    const turns: object[][] = [];
    for (let i = 0; i < 6; i++) turns.push(relayTurn({}, `call-${i}`, `run-${i}`));
    turns.push([{ type: "text-delta", textDelta: "finished" }]);
    stubSequence(...turns);
    const execute = vi.fn().mockResolvedValue({ ok: true });

    // maxAutoResumes is at its default of 3; six relayed calls must still complete.
    const text = await drain(callAgenticStream(relayOptions(execute)));

    expect(text).toBe("finished");
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("still bounds relayed calls, so a self-looping model cannot spin forever", async () => {
    const turns: object[][] = [];
    for (let i = 0; i < 5; i++) turns.push(relayTurn({}, `call-${i}`, `run-${i}`));
    stubSequence(...turns);
    const execute = vi.fn().mockResolvedValue({ ok: true });

    const err = await thrownBy(
      callAgenticStream({ ...relayOptions(execute), maxExternalToolCalls: 2 }),
    );

    expect(isAgenticStreamError(err)).toBe(true);
    expect((err as AgenticStreamError).reason).toBe("resume-budget-exhausted");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("omits externalTools entirely when the caller supplies none", async () => {
    const bodies = stubTurns([APPROVAL_FRAME]);

    await drain(callAgenticStream(DENY));

    expect(bodies[0]).not.toHaveProperty("externalTools");
    expect(bodies[1]).not.toHaveProperty("externalTools");
  });
});

describe("callAgenticStream — finish metadata (citations)", () => {
  const CITATION = {
    citation_id: "cit-1",
    citation_index: 1,
    title: "WC 2010",
    source_type: "kb" as const,
    doc_id: "doc-9",
    chunk_id: "chunk-3",
  };

  /** One turn: some text, then the terminal finish part. */
  function stubOneTurn(frames: object[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(sseResponse(frames))),
    );
  }

  // The whole point: without this a caller gets an answer full of `[1]` markers
  // and nothing to resolve them against.
  it("reports the citations the answer referenced", async () => {
    const onMetadata = vi.fn();
    stubOneTurn([
      { type: "text-delta", textDelta: "Spain won. Ref: [1]" },
      { type: "finish", messageMetadata: { citations: [CITATION] } },
    ]);

    const text = await drain(
      callAgenticStream({ ...OPTIONS, approvalResolver: denyAllResolver, onMetadata }),
    );

    expect(text).toBe("Spain won. Ref: [1]");
    expect(onMetadata).toHaveBeenCalledTimes(1);
    expect(onMetadata.mock.calls[0]?.[0]).toEqual({ citations: [CITATION] });
  });

  it("passes usage and uncited retrieval hits through untouched", async () => {
    const onMetadata = vi.fn();
    stubOneTurn([
      { type: "text-delta", textDelta: "hi" },
      {
        type: "finish",
        messageMetadata: {
          citations: [CITATION],
          searchedDocuments: [{ doc_id: "doc-2" }],
          usage: { inputTokens: 10, outputTokens: 4 },
        },
      },
    ]);

    await drain(callAgenticStream({ ...OPTIONS, approvalResolver: denyAllResolver, onMetadata }));

    expect(onMetadata.mock.calls[0]?.[0]).toMatchObject({
      searchedDocuments: [{ doc_id: "doc-2" }],
      usage: { inputTokens: 10, outputTokens: 4 },
    });
  });

  // The server omits the key entirely when there is nothing to report. Firing
  // with an empty object would have callers clear state they had legitimately
  // filled in on an earlier turn.
  it("stays silent when the finish part carries no metadata", async () => {
    const onMetadata = vi.fn();
    stubOneTurn([{ type: "text-delta", textDelta: "hi" }, { type: "finish" }]);

    await drain(callAgenticStream({ ...OPTIONS, approvalResolver: denyAllResolver, onMetadata }));

    expect(onMetadata).not.toHaveBeenCalled();
  });

  it("is optional — a caller that does not want metadata is unaffected", async () => {
    stubOneTurn([
      { type: "text-delta", textDelta: "hi" },
      { type: "finish", messageMetadata: { citations: [CITATION] } },
    ]);

    await expect(
      drain(callAgenticStream({ ...OPTIONS, approvalResolver: denyAllResolver })),
    ).resolves.toBe("hi");
  });

  // A relayed turn makes several POSTs and only the last carries a finish part,
  // so the callback must not fire once per request.
  it("fires once per turn, not once per resume request", async () => {
    const onMetadata = vi.fn();
    const bodies = stubTurns([
      {
        type: "data-tool-call-suspended",
        data: { runId: "run-w1", toolCallId: "call-w1", toolName: "propose_edits" },
      },
    ]);

    await drain(
      callAgenticStream({
        ...OPTIONS,
        approvalResolver: denyAllResolver,
        onMetadata,
        externalTools: [{ name: "propose_edits", description: "d", parameters: {} }],
        executeExternalTool: () => Promise.resolve({ ok: true }),
      }),
    );

    // Two POSTs, and the resume answers with plain text and no finish metadata.
    expect(bodies).toHaveLength(2);
    expect(onMetadata).not.toHaveBeenCalled();
  });
});
