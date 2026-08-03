import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../settings/auth-mode.js";
import { autoApproveResolver } from "./agentic/client.js";
import { invalidateConvoDetailCache, sendMessage } from "./messages.js";

/**
 * PDEV-7330 — the acceptance criterion, on the path the defect actually took.
 *
 * `ms-outlook-addin/src/components/DraftSection.tsx:247` calls
 * `sendMessage(authCtx, convoId, message)` with NO options, so no
 * `approvalResolver` reaches the Agentic client. Previously that fell through to
 * `autoApproveResolver` and every server-side tool ran unattended. These tests
 * drive the real routing (`GET …/general-info` → agent set → Agentic) and assert
 * on the resume body.
 */

const CONVO = "convo-7330";
const AGENT = "agent-7330";

const CTX: AuthContext = {
  baseUrl: "https://api.example.com",
  token: "header.payload.sig",
  orgId: "org-1",
  mode: "oauth",
  userId: "user-1",
};

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

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    // Required since PDEV-7337 routed these reads through the Transporter, which
    // records response headers. The `as unknown as Response` cast below is what
    // let the stub omit it — a real Response always has them.
    headers: new Headers(),
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  } as unknown as Response;
}

const APPROVAL_FRAME = {
  type: "data-tool-call-approval",
  data: { runId: "run-1", toolCallId: "call-1", toolName: "sendEmail" },
};

/**
 * Route sendMessage down the Agentic path: first the general-info GET (agent
 * set), then the agentic POST emitting an approval frame, then the resume.
 * Returns the agentic request bodies only.
 */
function stubAgenticConversation() {
  const agenticBodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { body?: string }) => {
      if (url.includes("general-info")) {
        return Promise.resolve(jsonResponse({ id: CONVO, agent: AGENT }));
      }
      agenticBodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
      return Promise.resolve(
        agenticBodies.length === 1
          ? sseResponse([APPROVAL_FRAME])
          : sseResponse([{ type: "text-delta", textDelta: "ok" }]),
      );
    }),
  );
  return agenticBodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // The agent assignment is cached for 5 min — clear it between tests.
  invalidateConvoDetailCache(CONVO);
});

describe("sendMessage — Agentic tool approval with no resolver configured", () => {
  it("does NOT resume with approved:true (the PDEV-7330 acceptance criterion)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bodies = stubAgenticConversation();

    await sendMessage(CTX, CONVO, "send the email");

    expect(bodies).toHaveLength(2);
    expect(bodies[1].resumeData).toEqual({ approved: false });
    expect(JSON.stringify(bodies[1])).not.toContain('"approved":true');

    // And it says so, naming the tool and the fix — a silent denial is its own bug.
    expect(warn).toHaveBeenCalledOnce();
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("sendEmail");
    expect(msg).toContain("approvalResolver");
  });

  it("honours an explicit resolver when the caller passes one", async () => {
    const bodies = stubAgenticConversation();

    await sendMessage(CTX, CONVO, "send the email", {
      approvalResolver: autoApproveResolver,
    });

    expect(bodies[1].resumeData).toEqual({ approved: true });
  });

  it("warns per refused call, not per send — a tool-free turn stays silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.includes("general-info")
            ? jsonResponse({ id: CONVO, agent: AGENT })
            : sseResponse([{ type: "text-delta", textDelta: "just prose" }]),
        ),
      ),
    );

    const out = await sendMessage(CTX, CONVO, "just answer");

    expect(out).toBe("just prose");
    expect(warn).not.toHaveBeenCalled();
  });
});
