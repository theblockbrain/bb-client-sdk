/**
 * A pre-flight guard for the client-executed tool relay (PDEV-6627).
 *
 * ─── The failure this exists to kill ─────────────────────────────────────────
 *
 * The relay only works if `externalTools` reaches the server: it rebuilds the
 * relay toolset from that array on **every** request of a turn, resumes
 * included. When the array does not arrive the server builds no toolset, the
 * agent is told it has tools it cannot actually call, and it then stalls or
 * narrates prose about work it never did. There is no error, no log and no 4xx —
 * the turn simply produces a confident, wrong answer.
 *
 * Two ways to arrive there, and neither announces itself:
 *
 * 1. **A build with no relay.** `callAgenticStream` destructures a fixed set of
 *    options, so on a release that predates the relay an `externalTools` field
 *    handed to it is never read. `ms-word-addin` hit exactly this: it declares
 *    `^0.18.0`, and published 0.18.0 has no relay at all — the string
 *    `externalTools` appears nowhere in its `dist/`. That is the DEFAULT state
 *    for CI, a fresh clone and every deployed build, so the failure lands where
 *    nobody is watching.
 * 2. **A caller that assembled the body itself** and dropped the field, or
 *    passed an empty array (which the client omits from the body entirely, and
 *    which therefore reaches the server as no relay at all).
 *
 * ─── Why it wraps the transport ──────────────────────────────────────────────
 *
 * This observes the ACTUAL serialized request rather than a proxy for it. By the
 * time a request reaches a {@link Transporter}, the body is the exact JSON the
 * server would receive, so the check cannot be fooled by an option that looked
 * right and was never forwarded. Nothing is sent when it fails: no run is
 * created, no tokens are burned, and the caller gets the reason instead of a
 * turn that quietly invents edits.
 *
 * It is opt-in. A surface whose agent has no client-executed tools must not wrap
 * its transport in this — every one of its turns would be refused.
 *
 * ```ts
 * const stream = await callAgenticStream({
 *   ...options,
 *   externalTools: tools,
 *   executeExternalTool: run,
 *   transport: assertRelayOnTheWire(getTransport()),
 * });
 * ```
 */

import type { Transporter, TransportRequest, TransportResponse } from "../transport.js";

/**
 * The agentic stream route, as the SDK asks the transport for it.
 *
 * Kept in step with `agenticStreamPath` in `client.ts`, and matched on the path
 * alone rather than also requiring `host === "agentic"`. The path is unique to
 * this route, and a host check would give the guard a second way to be silently
 * skipped if that host key were ever renamed — the same class of silent miss the
 * guard exists to prevent.
 */
const AGENT_STREAM_PATH = /^\/v2\/api\/agents\/[^/]+\/stream$/;

/**
 * The request that would have stranded the turn.
 *
 * Carries the path but **never the body**. An agentic request body holds the
 * user's message and, for a document surface, document text — and an
 * `Error.message` is rendered, logged, and forwarded to Sentry verbatim.
 */
export class RelayNotOnTheWireError extends Error {
  /** Host-relative path of the refused request. Never the body. */
  readonly path: string;

  constructor(path: string) {
    super(
      `The agent stream request to ${path} carried no externalTools, so the server would build no ` +
        "relay toolset and the agent would be offered client-executed tools it cannot actually call. " +
        "Either the installed @theblockbrain/bb-client-sdk predates the relay and dropped the field " +
        "without an error, or the call passed no tools (an empty array counts as none). Check the " +
        "installed version, then that externalTools is non-empty on every request of the turn.",
    );
    this.name = "RelayNotOnTheWireError";
    this.path = path;
    // Preserve prototype for instanceof across bundler realms — same reason as
    // AgenticStreamError.
    Object.setPrototypeOf(this, RelayNotOnTheWireError.prototype);
  }
}

/** Type guard for {@link RelayNotOnTheWireError}. */
export function isRelayNotOnTheWireError(err: unknown): err is RelayNotOnTheWireError {
  return err instanceof RelayNotOnTheWireError;
}

/**
 * Whether a serialized body declares at least one relay tool.
 *
 * An EMPTY array counts as absent, and correctly so: the client only writes
 * `externalTools` into the body when the array is non-empty, so an empty one
 * reaches the server as no relay at all. Same stalled turn, so the same answer.
 *
 * A `FormData` body cannot declare tools, and neither can an unparseable one.
 * Both are treated as missing rather than waved through, because the guard's
 * whole value is that it has no quiet path.
 */
export function bodyDeclaresRelay(body: string | FormData | undefined): boolean {
  if (typeof body !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object") return false;
    const tools = (parsed as { externalTools?: unknown }).externalTools;
    return Array.isArray(tools) && tools.length > 0;
  } catch {
    return false;
  }
}

/**
 * Wrap a transporter so an agent turn cannot leave without its relay tools.
 *
 * Scoped to POST on the stream path, which is the only request that carries the
 * relay declaration. Everything else passes through untouched, so one wrapped
 * transporter can still serve the whole surface.
 */
export function assertRelayOnTheWire(inner: Transporter): Transporter {
  return {
    send(req: TransportRequest): Promise<TransportResponse> {
      if (
        req.method === "POST" &&
        AGENT_STREAM_PATH.test(req.path) &&
        !bodyDeclaresRelay(req.body)
      ) {
        // Rejected rather than thrown synchronously, because `Transporter.send`
        // promises a promise and a caller may well be holding only a `.catch`.
        return Promise.reject(new RelayNotOnTheWireError(req.path));
      }
      // Delegated without an `await` so a streaming response object crosses this
      // seam untouched.
      return inner.send(req);
    },
  };
}
