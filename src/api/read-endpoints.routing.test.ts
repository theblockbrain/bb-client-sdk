import { afterEach, describe, expect, it } from "vitest";
import { resetAnalyticsAdapter, setAnalyticsAdapter } from "../analytics/index.js";
import type { AuthContext } from "../settings/auth-mode.js";
import { fetchAgents, setAgentActive } from "./agents.js";
import { fetchBotDetail, fetchBotList } from "./bots.js";
import { fetchCapabilities, setCapabilityActive } from "./capabilities.js";
import { deleteConversation } from "./conversations.js";
import { BBApiError } from "./errors.js";
import { sendMessage } from "./messages.js";
import { createNote } from "./notes.js";
import { getTenantConfig } from "./tenant-config.js";
import type { Transporter, TransportRequest, TransportResponse } from "./transport.js";
import { getAvailableWebSearchProviders, getConversationWebSearch } from "./websearch.js";

/**
 * PDEV-7337. What every migrated read actually puts on the wire.
 *
 * These endpoints had **no tests at all** before the Transporter, because
 * asserting a URL meant intercepting global `fetch`. `ctx.transport` makes the
 * request a plain value, so host, path, method and query are now checkable —
 * which is how `/cortex/web-search/provider` was able to be wrong for as long as
 * it was. Nothing ever looked.
 */

/** Capture the request instead of sending it. */
function recorder(body: unknown = {}) {
  const sent: TransportRequest[] = [];
  const transport: Transporter = {
    send(req) {
      sent.push(req);
      const res: TransportResponse = {
        status: 200,
        ok: true,
        headers: {},
        json: <T>() => Promise.resolve(body as T),
        text: () => Promise.resolve(JSON.stringify(body)),
      };
      return Promise.resolve(res);
    },
  };
  return { transport, sent, last: () => sent[sent.length - 1] };
}

function ctxWith(transport: Transporter, over: Partial<AuthContext> = {}): AuthContext {
  return {
    baseUrl: "https://blocky.example.test",
    token: "tok",
    orgId: "home-org",
    mode: "oauth",
    transport,
    ...over,
  };
}

describe("read endpoints — host and path routing", () => {
  it("fetchBotList hits blocky with paging query", async () => {
    const rec = recorder({ body: { data: [{ _id: "b1", name: "Bot" }] } });
    await fetchBotList(ctxWith(rec.transport));

    expect(rec.last()).toMatchObject({
      host: "blocky",
      path: "/cortex/active-bot/list",
      method: "GET",
      query: { page: 1, size: 100 },
    });
  });

  it("fetchBotDetail percent-encodes the id into the path", async () => {
    const rec = recorder({ body: { _id: "a/b" } });
    await fetchBotDetail(ctxWith(rec.transport), "a/b");

    // An unencoded slash would silently address a different route.
    expect(rec.last().path).toBe("/cortex/active-bot/a%2Fb");
  });

  it("fetchAgents hits the integrations host, not blocky", async () => {
    // The PDEV-7332 defect: these three lived on the wrong host entirely.
    const rec = recorder();
    await fetchAgents(ctxWith(rec.transport));

    expect(rec.last()).toMatchObject({
      host: "integrations",
      path: "/api/v1/agents",
      method: "GET",
      query: { orgId: "home-org" },
    });
  });

  it("fetchCapabilities hits the integrations host", async () => {
    const rec = recorder();
    await fetchCapabilities(ctxWith(rec.transport));

    expect(rec.last()).toMatchObject({ host: "integrations", path: "/api/v1/capabilities" });
  });

  it("getTenantConfig hits the integrations host", async () => {
    const rec = recorder({ id: "t", name: "T", config: { customAgentsEnabled: true } });
    await getTenantConfig(ctxWith(rec.transport));

    expect(rec.last()).toMatchObject({ host: "integrations", path: "/api/v1/tenants" });
  });

  it("getAvailableWebSearchProviders uses /websearch, not /web-search", async () => {
    // The silent 404 PDEV-7337 called out. Blocky mounts the router at
    // prefix="/websearch" (api/nexus/routes.py:91) — no hyphen.
    const rec = recorder([]);
    await getAvailableWebSearchProviders(ctxWith(rec.transport));

    expect(rec.last().path).toBe("/cortex/websearch/provider");
    expect(rec.last().path).not.toContain("web-search");
  });
});

describe("read endpoints — tenant routing", () => {
  it("sends the home org as x-zitadel-org-id and the target as ?orgId=", async () => {
    // The isolation boundary: identity in the header, subject in the query.
    const rec = recorder();
    await fetchAgents(ctxWith(rec.transport), "target-org");

    expect(rec.last().query).toMatchObject({ orgId: "target-org" });
    expect(rec.last().headers).toMatchObject({ "x-zitadel-org-id": "home-org" });
  });

  it("defaults the query org to the home org for a self-tenant call", async () => {
    const rec = recorder();
    await fetchAgents(ctxWith(rec.transport));

    expect(rec.last().query).toMatchObject({ orgId: "home-org" });
  });

  it("omits x-zitadel-org-id on the integrations host in api-key mode", async () => {
    // The integrations host 500s on the header in api-key mode.
    const rec = recorder();
    await fetchAgents(ctxWith(rec.transport, { mode: "api-key" }));

    expect(rec.last().headers).not.toHaveProperty("x-zitadel-org-id");
  });

  it("omits the admin listing flags unless explicitly true", async () => {
    // Sending them at all puts a normal user on the admin branch — a 403.
    const rec = recorder();
    await fetchAgents(ctxWith(rec.transport), undefined, { includeInactive: false });

    expect(rec.last().query).not.toHaveProperty("includeInactive");
    expect(rec.last().query).not.toHaveProperty("includeUnavailable");
  });

  it("passes the admin listing flags through when opted into", async () => {
    const rec = recorder();
    await fetchAgents(ctxWith(rec.transport), undefined, { includeInactive: true });

    expect(rec.last().query).toMatchObject({ includeInactive: "true" });
  });
});

describe("read endpoints — non-2xx", () => {
  it("throws BBApiError carrying statusCode and endpoint", async () => {
    // trackApiError forwards exactly these two into the api_error event.
    const transport: Transporter = {
      send: () =>
        Promise.resolve({
          status: 503,
          ok: false,
          headers: {},
          json: <T>() => Promise.resolve({ detail: "down" } as T),
          text: () => Promise.resolve(""),
        }),
    };

    await expect(fetchBotList(ctxWith(transport))).rejects.toMatchObject({
      name: "BBApiError",
      statusCode: 503,
      endpoint: "/cortex/active-bot/list",
    });
  });
  it("getConversationWebSearch percent-encodes convoId in the path", async () => {
    const rec = recorder({ enableWebSearch: true });
    await getConversationWebSearch(ctxWith(rec.transport), "a/b c?d");

    expect(rec.last()).toMatchObject({
      host: "blocky",
      method: "GET",
      path: "/cortex/conversation/a%2Fb%20c%3Fd",
    });
  });

  it("reports the encoded path as BBApiError.endpoint, not the raw id", async () => {
    // The endpoint string is what BBApiError carries, so it has to be the path
    // actually requested. It was built from the raw convoId while the request
    // used the encoded one, so an id containing `/` or `?` reported an endpoint
    // that was never called. PDEV-7009 keys the api_error event on this same
    // string, which is what makes the mismatch worth a test rather than a shrug.
    const transport: Transporter = {
      send: (): Promise<TransportResponse> =>
        Promise.resolve({
          status: 404,
          ok: false,
          headers: {},
          json: <T>() => Promise.resolve({} as T),
          text: () => Promise.resolve(""),
        }),
    };

    await expect(getConversationWebSearch(ctxWith(transport), "a/b c?d")).rejects.toMatchObject({
      name: "BBApiError",
      statusCode: 404,
      endpoint: "/cortex/conversation/a%2Fb%20c%3Fd",
    });
  });
});

/**
 * PDEV-7338's acceptance criterion: one error shape, whatever the host or verb.
 *
 * There used to be two normalisation points — `throwIfNotOk(res: Response)` in
 * `_auth-headers.ts` for the integrations host, and inline `new BBApiError` on
 * blocky — so a non-2xx produced a differently-shaped error depending on which
 * host you happened to call. That is what stops `trackApiError` working without
 * per-endpoint instrumentation (WS9). `_send.ts` now owns the only one.
 */
describe("every endpoint normalises a non-2xx identically", () => {
  function failing(status: number): Transporter {
    return {
      send: () =>
        Promise.resolve({
          status,
          ok: false,
          headers: {},
          json: <T>() => Promise.resolve({ detail: "nope" } as T),
          text: () => Promise.resolve(""),
        }),
    };
  }

  const cases: Array<[string, (ctx: AuthContext) => Promise<unknown>, string]> = [
    ["fetchBotList (blocky GET)", c => fetchBotList(c), "/cortex/active-bot/list"],
    ["fetchAgents (integrations GET)", c => fetchAgents(c), "/api/v1/agents"],
    ["fetchCapabilities (integrations GET)", c => fetchCapabilities(c), "/api/v1/capabilities"],
    ["getTenantConfig (integrations GET)", c => getTenantConfig(c), "/api/v1/tenants"],
    [
      "setAgentActive (integrations PATCH)",
      c => setAgentActive(c, "a1", true),
      "/api/v1/agents/set-active",
    ],
    [
      "setCapabilityActive (integrations PATCH)",
      c => setCapabilityActive(c, "c1", true),
      "/api/v1/capabilities/set-active",
    ],
    [
      "createNote (blocky POST)",
      c => createNote(c, { title: "t", summary: "s" }),
      "/cortex/notes/add-note",
    ],
    [
      "deleteConversation (blocky DELETE)",
      c => deleteConversation(c, "c1"),
      "/cortex/conversation/c1",
    ],
  ];

  it.each(cases)("%s throws the same shape", async (_label, call, endpoint) => {
    const err = await call(ctxWith(failing(503))).then(
      () => null,
      (e: unknown) => e,
    );

    // Same class, same fields, same statusCode — across two hosts and four verbs.
    expect(err).toBeInstanceOf(BBApiError);
    expect(err).toMatchObject({ name: "BBApiError", statusCode: 503, endpoint });
    // trackApiError forwards statusCode + endpoint and NEVER responseBody, which
    // can echo secrets — but the field must exist for local diagnostics.
    expect(err).toHaveProperty("responseBody");
  });

  it("preserves the real status rather than collapsing to a generic failure", async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      const err = await fetchAgents(ctxWith(failing(status))).catch((e: unknown) => e);
      expect((err as BBApiError).statusCode).toBe(status);
    }
  });
});

describe("cancellation reaches the transport (PDEV-7339)", () => {
  it("forwards the caller's AbortSignal on a streamed send", async () => {
    // Before this, `useChatStream().stop()` stopped consuming but the request
    // kept running server-side. The signal has to reach the transport for an
    // abort to mean anything.
    const rec = recorder();
    const controller = new AbortController();

    await sendMessage(ctxWith(rec.transport), "c1", "hi", {
      enableStreaming: false,
      signal: controller.signal,
    }).catch(() => undefined);

    expect(rec.sent.some(r => r.signal === controller.signal)).toBe(true);
  });

  it("asks the transport to stream only when streaming was requested", async () => {
    // A streamed request gets no timeout; a buffered one must keep its deadline.
    const rec = recorder({ body: { content: "hi" } });
    await sendMessage(ctxWith(rec.transport), "c1", "hi").catch(() => undefined);

    expect(rec.sent.some(r => r.stream === true)).toBe(false);
  });
});

/**
 * PDEV-7009 — one `api_error` emit point.
 *
 * WS9 asks for telemetry emitted "from ONE point — inside the WS2 transport
 * seam — not per call site". That only became possible once PDEV-7338 collapsed
 * the two error paths into `throwIfNotOk`, so every non-2xx on every host now
 * passes through a single function.
 */
describe("api_error is emitted once, from the seam (PDEV-7009)", () => {
  function failing(status: number): Transporter {
    return {
      send: () =>
        Promise.resolve({
          status,
          ok: false,
          headers: {},
          json: <T>() => Promise.resolve({ secret: "do-not-forward" } as T),
          text: () => Promise.resolve(""),
        }),
    };
  }

  function recorderAdapter() {
    const events: Array<{ event: string; props: Record<string, unknown> }> = [];
    setAnalyticsAdapter({
      track: (event, props) => events.push({ event, props }),
      captureError: () => {},
    });
    return events;
  }

  afterEach(() => resetAnalyticsAdapter());

  it("emits api_error with statusCode and endpoint, from an endpoint that never instruments itself", async () => {
    const events = recorderAdapter();

    await fetchBotList(ctxWith(failing(503))).catch(() => undefined);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "api_error",
      props: { statusCode: 503, endpoint: "/cortex/active-bot/list" },
    });
  });

  it("NEVER forwards responseBody — it can echo a token", async () => {
    // Invariant D. The error carries the body for local diagnostics; the event
    // must not, because a surface forwards events straight to Mixpanel/Sentry.
    const events = recorderAdapter();

    await fetchBotList(ctxWith(failing(401))).catch(() => undefined);

    expect(JSON.stringify(events)).not.toContain("do-not-forward");
    expect(events[0].props).toEqual({ statusCode: 401, endpoint: "/cortex/active-bot/list" });
  });

  it("emits for the integrations host too — one point, not one per host", async () => {
    const events = recorderAdapter();

    await fetchAgents(ctxWith(failing(403))).catch(() => undefined);

    expect(events[0]).toMatchObject({
      event: "api_error",
      props: { statusCode: 403, endpoint: "/api/v1/agents" },
    });
  });

  it("still throws the original error when no adapter is registered", async () => {
    resetAnalyticsAdapter();

    await expect(fetchBotList(ctxWith(failing(500)))).rejects.toMatchObject({ statusCode: 500 });
  });

  it("a throwing adapter cannot break the request path", async () => {
    // The sink swallows adapter faults; the caller must still get its BBApiError.
    setAnalyticsAdapter({
      track: () => {
        throw new Error("adapter exploded");
      },
      captureError: () => {},
    });

    await expect(fetchBotList(ctxWith(failing(502)))).rejects.toMatchObject({ statusCode: 502 });
  });
});
