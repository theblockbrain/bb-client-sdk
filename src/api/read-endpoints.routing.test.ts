import { describe, expect, it } from "vitest";
import type { AuthContext } from "../settings/auth-mode.js";
import { fetchAgents } from "./agents.js";
import { fetchBotDetail, fetchBotList } from "./bots.js";
import { fetchCapabilities } from "./capabilities.js";
import { getTenantConfig } from "./tenant-config.js";
import type { Transporter, TransportRequest, TransportResponse } from "./transport.js";
import { getAvailableWebSearchProviders } from "./websearch.js";

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
});
