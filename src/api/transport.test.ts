import { describe, expect, it, vi } from "vitest";

import {
  AGENTIC_BASE_URL,
  AUTH_AUTHORITY,
  INTEGRATIONS_BASE_URL,
  OAUTH_BACKEND_URL,
} from "../config.js";
import { isBBApiError } from "./errors.js";
import {
  createFetchTransport,
  DEFAULT_HOSTS,
  DEFAULT_TIMEOUT_MS,
  type TransportRequest,
} from "./transport.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type FetchImpl = typeof globalThis.fetch;

/** `fetch` accepts three input shapes; only `Request` needs unwrapping to a string. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** Records the URL + init it was called with, and replies with `response`. */
function stubFetch(response: Response | (() => Response)) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl: FetchImpl = (url, init) => {
    calls.push({ url: urlOf(url), init });
    return Promise.resolve(typeof response === "function" ? response() : response);
  };
  return { impl, calls };
}

/** Never resolves on its own — only ever settles by rejecting on abort. */
function hangingFetch(): FetchImpl {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function byteStream(chunks: readonly Uint8Array[], delayMs = 0): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function collect(source: AsyncIterable<string>): Promise<string> {
  const parts: string[] = [];
  for await (const part of source) parts.push(part);
  return parts.join("");
}

const GET: Pick<TransportRequest, "host" | "path" | "method"> = {
  host: "blocky",
  path: "/bots",
  method: "GET",
};

// ─── Hosts + URL construction ─────────────────────────────────────────────────

describe("createFetchTransport — URL construction", () => {
  it("resolves each host from the production defaults", () => {
    expect(DEFAULT_HOSTS).toEqual({
      blocky: OAUTH_BACKEND_URL,
      integrations: INTEGRATIONS_BASE_URL,
      agentic: AGENTIC_BASE_URL,
      // PDEV-7339: the Zitadel authority is a host like any other, so token
      // calls get the same proxy rewrite, timeout and retry as everything else.
      auth: AUTH_AUTHORITY,
    });
  });

  it.each([
    ["blocky", OAUTH_BACKEND_URL],
    ["integrations", INTEGRATIONS_BASE_URL],
    ["agentic", AGENTIC_BASE_URL],
  ] as const)("routes host %s to its own origin", async (host, expected) => {
    const { impl, calls } = stubFetch(jsonResponse({}));
    await createFetchTransport({ fetch: impl }).send({ ...GET, host, path: "/x" });

    expect(calls[0]?.url).toBe(`${expected}/x`);
  });

  it("merges a hosts override over the defaults, leaving the others intact", async () => {
    // Factory, not a shared instance — a Response body can only be read once.
    const { impl, calls } = stubFetch(() => jsonResponse({}));
    const transport = createFetchTransport({
      fetch: impl,
      hosts: { integrations: "https://integrations.dev.theblockbrain.ai" },
    });

    await transport.send({ ...GET, host: "integrations", path: "/agents" });
    await transport.send({ ...GET, host: "blocky", path: "/bots" });

    expect(calls[0]?.url).toBe("https://integrations.dev.theblockbrain.ai/agents");
    expect(calls[1]?.url).toBe(`${OAUTH_BACKEND_URL}/bots`);
  });

  it("tolerates a missing leading slash and a trailing slash on the host", async () => {
    const { impl, calls } = stubFetch(jsonResponse({}));
    const transport = createFetchTransport({
      fetch: impl,
      hosts: { blocky: "https://example.test///" },
    });

    await transport.send({ ...GET, path: "bots" });

    expect(calls[0]?.url).toBe("https://example.test/bots");
  });

  it("serialises query values and drops undefined rather than stringifying it", async () => {
    const { impl, calls } = stubFetch(jsonResponse({}));
    await createFetchTransport({ fetch: impl }).send({
      ...GET,
      query: { orgId: "org-1", page: 2, includeInactive: true, targetOrgId: undefined },
    });

    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("orgId")).toBe("org-1");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("includeInactive")).toBe("true");
    expect(url.searchParams.has("targetOrgId")).toBe(false);
  });

  it("hands the rewrite hook a parseable URL — b2b needs pathname AND search", async () => {
    const { impl, calls } = stubFetch(jsonResponse({}));
    const seen: { pathname: string; search: string; host: string }[] = [];

    await createFetchTransport({
      fetch: impl,
      // The real b2b rewrite, verbatim.
      rewriteUrl: (url, host) => {
        seen.push({ pathname: url.pathname, search: url.search, host });
        return `https://proxy.test/wc/proxy${url.pathname}${url.search}`;
      },
    }).send({ ...GET, path: "/conversations/abc", query: { orgId: "org-1" } });

    expect(seen[0]).toEqual({
      pathname: "/conversations/abc",
      search: "?orgId=org-1",
      host: "blocky",
    });
    expect(calls[0]?.url).toBe("https://proxy.test/wc/proxy/conversations/abc?orgId=org-1");
  });
});

// ─── Headers ──────────────────────────────────────────────────────────────────

describe("createFetchTransport — headers", () => {
  it("lower-cases request header keys", async () => {
    const { impl, calls } = stubFetch(jsonResponse({}));
    await createFetchTransport({ fetch: impl }).send({
      ...GET,
      headers: { "X-Zitadel-Org-Id": "org-1", Authorization: "Bearer t" },
    });

    expect(calls[0]?.init?.headers).toEqual({
      "x-zitadel-org-id": "org-1",
      authorization: "Bearer t",
    });
  });

  it("lower-cases response header keys", async () => {
    const { impl } = stubFetch(jsonResponse({}, 200, { "X-Request-Id": "req-1" }));
    const res = await createFetchTransport({ fetch: impl }).send(GET);

    expect(res.headers["x-request-id"]).toBe("req-1");
  });
});

// ─── Status handling ──────────────────────────────────────────────────────────

describe("createFetchTransport — status handling", () => {
  it("returns the parsed body on 2xx", async () => {
    const { impl } = stubFetch(jsonResponse({ id: "bot-1" }));
    const res = await createFetchTransport({ fetch: impl }).send(GET);

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json<{ id: string }>()).resolves.toEqual({ id: "bot-1" });
  });

  it("does NOT throw on non-2xx — deciding that is the endpoint's job", async () => {
    // discoverFrontendUrls (tenant.ts:30) legitimately treats a non-2xx as "no
    // data" and returns null. A transport that threw would break it.
    const { impl } = stubFetch(jsonResponse({ message: "nope" }, 404));
    const res = await createFetchTransport({ fetch: impl }).send(GET);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    await expect(res.json<{ message: string }>()).resolves.toEqual({ message: "nope" });
  });

  it("rejects with a parse-kind BBApiError when the body is not JSON", async () => {
    const { impl } = stubFetch(new Response("<html>502</html>", { status: 502 }));
    const res = await createFetchTransport({ fetch: impl }).send(GET);

    expect(res.ok).toBe(false);
    await expect(res.json()).rejects.toMatchObject({ kind: "parse", statusCode: 0 });
    // …but the raw text is still reachable, so a caller can log the gateway page.
    await expect(res.text()).resolves.toBe("<html>502</html>");
  });
});

// ─── Failure kinds ────────────────────────────────────────────────────────────

describe("createFetchTransport — failure kinds", () => {
  it("maps a fetch rejection to kind 'network' with statusCode 0", async () => {
    const impl = (() => Promise.reject(new TypeError("Failed to fetch"))) as FetchImpl;

    const error = await createFetchTransport({ fetch: impl })
      .send(GET)
      .catch((e: unknown) => e);

    expect(isBBApiError(error)).toBe(true);
    expect(error).toMatchObject({ kind: "network", statusCode: 0, endpoint: "/bots" });
  });

  it("maps a caller abort to kind 'aborted'", async () => {
    const controller = new AbortController();
    const pending = createFetchTransport({ fetch: hangingFetch() })
      .send({ ...GET, signal: controller.signal })
      .catch((e: unknown) => e);

    controller.abort();

    expect(await pending).toMatchObject({ kind: "aborted", statusCode: 0 });
  });

  it("maps an already-aborted signal to kind 'aborted' without hanging", async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await createFetchTransport({ fetch: hangingFetch() })
      .send({ ...GET, signal: controller.signal })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: "aborted" });
  });

  it("maps its own deadline to kind 'timeout', distinct from a caller abort", async () => {
    const error = await createFetchTransport({ fetch: hangingFetch(), timeoutMs: 10 })
      .send(GET)
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: "timeout", statusCode: 0, endpoint: "/bots" });
  });

  it("lets a per-request timeoutMs override the config default", async () => {
    const error = await createFetchTransport({ fetch: hangingFetch(), timeoutMs: 60_000 })
      .send({ ...GET, timeoutMs: 10 })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: "timeout" });
  });

  it("names the path, never the built URL, so query values cannot leak into messages", async () => {
    const impl = (() => Promise.reject(new TypeError("Failed to fetch"))) as FetchImpl;

    const error = await createFetchTransport({ fetch: impl })
      .send({ ...GET, path: "/tenants", query: { orgId: "org-secret" } })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ endpoint: "/tenants" });
    expect(String(error)).not.toContain("org-secret");
  });

  it("fails with kind 'network' when no fetch implementation exists at all", async () => {
    const original = globalThis.fetch;
    // Reflect.deleteProperty rather than `delete` — same effect, no lint suppression.
    Reflect.deleteProperty(globalThis, "fetch");

    try {
      const error = await createFetchTransport()
        .send(GET)
        .catch((e: unknown) => e);

      expect(error).toMatchObject({ kind: "network" });
      expect(String(error)).toContain("TransportConfig.fetch");
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ─── Streaming ────────────────────────────────────────────────────────────────

describe("createFetchTransport — streaming", () => {
  it("yields decoded text chunks, not bytes", async () => {
    const stream = byteStream([bytes("data: a\n\n"), bytes("data: b\n\n")]);
    const { impl } = stubFetch(new Response(stream));

    const res = await createFetchTransport({ fetch: impl }).send({ ...GET, stream: true });

    expect(res.chunks).toBeDefined();
    await expect(collect(res.chunks as AsyncIterable<string>)).resolves.toBe(
      "data: a\n\ndata: b\n\n",
    );
  });

  it("reassembles a multi-byte character split across two chunks", async () => {
    // "é" is 0xC3 0xA9 — a naive per-chunk decode would produce two replacement chars.
    const stream = byteStream([new Uint8Array([0xc3]), new Uint8Array([0xa9])]);
    const { impl } = stubFetch(new Response(stream));

    const res = await createFetchTransport({ fetch: impl }).send({ ...GET, stream: true });

    await expect(collect(res.chunks as AsyncIterable<string>)).resolves.toBe("é");
  });

  it("applies NO timeout to a streaming request", async () => {
    // Deadline is 10ms; the stream takes ~60ms. A blanket timeout would kill it.
    const stream = byteStream([bytes("one"), bytes("two"), bytes("three")], 20);
    const { impl } = stubFetch(new Response(stream));

    const res = await createFetchTransport({ fetch: impl, timeoutMs: 10 }).send({
      ...GET,
      stream: true,
    });

    await expect(collect(res.chunks as AsyncIterable<string>)).resolves.toBe("onetwothree");
  });

  it("still exposes status and headers alongside the stream", async () => {
    const { impl } = stubFetch(
      new Response(byteStream([bytes("x")]), { status: 201, headers: { "X-Run-Id": "run-1" } }),
    );

    const res = await createFetchTransport({ fetch: impl }).send({ ...GET, stream: true });

    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(res.headers["x-run-id"]).toBe("run-1");
  });

  it("completes cleanly when the response has no body", async () => {
    const { impl } = stubFetch(new Response(null, { status: 204 }));

    const res = await createFetchTransport({ fetch: impl }).send({ ...GET, stream: true });

    await expect(collect(res.chunks as AsyncIterable<string>)).resolves.toBe("");
  });
});

// ─── Defaults ─────────────────────────────────────────────────────────────────

describe("createFetchTransport — defaults", () => {
  it("uses b2b's production deadline, so the SDK does not invent a tighter policy", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(300_000);
  });

  it("resolves globalThis.fetch lazily, so importing the module never needs it", async () => {
    const spy = vi.fn(() => Promise.resolve(jsonResponse({ ok: true })));
    const original = globalThis.fetch;
    globalThis.fetch = spy;

    try {
      // Constructed BEFORE the global is read — proves the lookup is per-call.
      const transport = createFetchTransport();
      await transport.send(GET);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * PDEV-7340 — retry and the 401 replay.
 *
 * Both are opt-in. The default transport does neither, because a silent retry
 * changes timing every consumer already tuned around.
 */
describe("retry (PDEV-7340)", () => {
  const ok = () => new Response("{}", { status: 200 });
  const fail = (status: number) => new Response("{}", { status });

  it("retries a transient fetch rejection and returns the eventual success", async () => {
    // Retry covers a rejecting fetch as well as a retriable status, but only the
    // status path was covered — so nothing pinned the `catch` branch that keeps
    // going when `i < extra`. A DNS blip or a dropped socket is exactly the case
    // retry exists for.
    const doFetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(ok());
    const t = createFetchTransport({ fetch: doFetch, retry: { attempts: 2, baseDelayMs: 1 } });

    const res = await t.send({ host: "blocky", path: "/x", method: "GET" });

    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("still throws kind 'network' when every attempt rejects", async () => {
    const doFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const t = createFetchTransport({ fetch: doFetch, retry: { attempts: 2, baseDelayMs: 1 } });

    await expect(t.send({ host: "blocky", path: "/x", method: "GET" })).rejects.toMatchObject({
      kind: "network",
      statusCode: 0,
    });
    expect(doFetch).toHaveBeenCalledTimes(3);
  });

  it("sends the request even when the policy is nonsense", async () => {
    // A negative or NaN `attempts` made `i <= extra` false on the very first
    // iteration, so the loop body never ran: the request was never sent and the
    // caller got a fabricated "aborted" error from the tail throw.
    for (const attempts of [-1, Number.NaN, -0.5]) {
      const doFetch = vi.fn().mockResolvedValue(ok());
      const t = createFetchTransport({ fetch: doFetch, retry: { attempts, baseDelayMs: 1 } });

      const res = await t.send({ host: "blocky", path: "/x", method: "GET" });

      expect(res.status).toBe(200);
      expect(doFetch).toHaveBeenCalledTimes(1);
    }
  });

  it("treats an unusable baseDelayMs as unset rather than propagating NaN", async () => {
    const doFetch = vi.fn().mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(ok());
    const t = createFetchTransport({
      fetch: doFetch,
      retry: { attempts: 1, baseDelayMs: Number.NaN },
    });

    const res = await t.send({ host: "blocky", path: "/x", method: "GET" });

    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("releases the body of a response it discards before retrying", async () => {
    // An unconsumed body holds the connection until GC; undici warns about it.
    const cancel = vi.fn().mockResolvedValue(undefined);
    const retriable = new Response("{}", { status: 503 });
    Object.defineProperty(retriable, "body", { value: { cancel }, configurable: true });

    const doFetch = vi.fn().mockResolvedValueOnce(retriable).mockResolvedValueOnce(ok());
    const t = createFetchTransport({ fetch: doFetch, retry: { attempts: 2, baseDelayMs: 1 } });

    await t.send({ host: "blocky", path: "/x", method: "GET" });

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not retry unless a policy is configured", async () => {
    const doFetch = vi.fn().mockResolvedValue(fail(503));
    const t = createFetchTransport({ fetch: doFetch });

    await t.send({ host: "blocky", path: "/x", method: "GET" });

    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 on GET and returns the eventual success", async () => {
    const doFetch = vi.fn().mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(ok());
    const t = createFetchTransport({ fetch: doFetch, retry: { attempts: 2, baseDelayMs: 1 } });

    const res = await t.send({ host: "blocky", path: "/x", method: "GET" });

    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
  });

  it("retries a 429", async () => {
    const doFetch = vi.fn().mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok());
    const t = createFetchTransport({ fetch: doFetch, retry: { attempts: 2, baseDelayMs: 1 } });

    await t.send({ host: "blocky", path: "/x", method: "GET" });

    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("never retries a 4xx that is not 429 — it would fail identically", async () => {
    const doFetch = vi.fn().mockResolvedValue(fail(404));
    const t = createFetchTransport({ fetch: doFetch, retry: { attempts: 3, baseDelayMs: 1 } });

    await t.send({ host: "blocky", path: "/x", method: "GET" });

    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("never retries a POST — it could double-send a message", async () => {
    const doFetch = vi.fn().mockResolvedValue(fail(503));
    const t = createFetchTransport({ fetch: doFetch, retry: { attempts: 3, baseDelayMs: 1 } });

    await t.send({ host: "blocky", path: "/x", method: "POST", body: "{}" });

    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured attempts and surfaces the last response", async () => {
    // A fresh Response per call, not one shared instance: a body is single-use by
    // spec, so a real fetch cannot hand back the same Response three times. The
    // shared-instance version only passed while discarded bodies were left
    // unread — cancelling them (as the runtime wants) makes the fixture's
    // unreality visible.
    const doFetch = vi.fn().mockImplementation(() => Promise.resolve(fail(503)));
    const t = createFetchTransport({ fetch: doFetch, retry: { attempts: 2, baseDelayMs: 1 } });

    const res = await t.send({ host: "blocky", path: "/x", method: "GET" });

    expect(doFetch).toHaveBeenCalledTimes(3); // first + 2 retries
    expect(res.status).toBe(503);
  });
});

/**
 * PDEV-7340 review finding: `send()` disposed the abort plan on its success paths
 * but not when it threw. `dispose` clears the deadline timer and detaches the
 * caller-abort listener, so a failing request left both behind — in Node an
 * uncleared timer also keeps the event loop alive for the remainder of the
 * timeout, and a long-lived caller signal accumulates a listener per failed call.
 */
describe("abort-plan disposal on failure", () => {
  it("detaches the caller abort listener when the request throws", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const doFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const t = createFetchTransport({ fetch: doFetch });

    await expect(
      t.send({ host: "blocky", path: "/x", method: "GET", signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "network" });

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("detaches it when the refresh hook itself throws", async () => {
    // onUnauthorized is consumer code, so it can throw. That path escaped
    // disposal entirely before.
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const t = createFetchTransport({
      fetch: vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 401 }))),
      onUnauthorized: () => Promise.reject(new Error("refresh exploded")),
    });

    await expect(
      t.send({ host: "blocky", path: "/x", method: "GET", signal: controller.signal }),
    ).rejects.toThrow("refresh exploded");

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("clears the deadline timer when the request throws", async () => {
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    const doFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const t = createFetchTransport({ fetch: doFetch, timeoutMs: 30_000 });

    await expect(t.send({ host: "blocky", path: "/x", method: "GET" })).rejects.toMatchObject({
      kind: "network",
    });

    expect(cleared).toHaveBeenCalled();
  });
});

describe("401 refresh (PDEV-7340)", () => {
  const unauthorized = () => new Response("{}", { status: 401 });
  const ok = () => new Response('{"v":1}', { status: 200 });

  it("refreshes once and replays with the new token", async () => {
    const doFetch = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(ok());
    const onUnauthorized = vi.fn().mockResolvedValue("fresh-token");
    const t = createFetchTransport({ fetch: doFetch, onUnauthorized });

    const res = await t.send({
      host: "blocky",
      path: "/x",
      method: "GET",
      headers: { Authorization: "Bearer stale" },
    });

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    // The replay must carry the NEW token — replaying with the stale one would
    // just 401 again and look like a refresh that "didn't work".
    const replayHeaders = doFetch.mock.calls[1][1].headers as Record<string, string>;
    expect(replayHeaders.authorization).toBe("Bearer fresh-token");
  });

  it("does not loop when the refreshed token is also rejected", async () => {
    // Two 401s means an authorisation problem, not a stale token. Retrying is
    // how a login loop starts.
    const doFetch = vi.fn().mockResolvedValue(unauthorized());
    const onUnauthorized = vi.fn().mockResolvedValue("fresh-token");
    const t = createFetchTransport({ fetch: doFetch, onUnauthorized });

    const res = await t.send({ host: "blocky", path: "/x", method: "GET" });

    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(401);
  });

  it("lets the 401 through when refresh returns null", async () => {
    // The honest answer when the refresh token itself has expired.
    const doFetch = vi.fn().mockResolvedValue(unauthorized());
    const t = createFetchTransport({ fetch: doFetch, onUnauthorized: () => Promise.resolve(null) });

    const res = await t.send({ host: "blocky", path: "/x", method: "GET" });

    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(401);
  });

  it("does nothing on a 401 when no handler is configured", async () => {
    const doFetch = vi.fn().mockResolvedValue(unauthorized());
    const t = createFetchTransport({ fetch: doFetch });

    const res = await t.send({ host: "blocky", path: "/x", method: "GET" });

    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(401);
  });
});
