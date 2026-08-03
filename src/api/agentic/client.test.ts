import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageStream } from "../stream-result.js";
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
