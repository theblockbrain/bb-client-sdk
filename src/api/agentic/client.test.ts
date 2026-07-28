import { afterEach, describe, expect, it, vi } from "vitest";
import { autoApproveResolver, callAgenticStream, denyAllResolver } from "./client.js";

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
