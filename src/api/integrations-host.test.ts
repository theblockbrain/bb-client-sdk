/**
 * PDEV-7332 — the wrong-host bug and the non-admin 403.
 *
 * Two independent defects, both proven here against the request the SDK actually
 * builds:
 *
 * 1. All eight integrations functions built their URL from `ctx.baseUrl`, which
 *    `getAuthContext` sets to `OAUTH_BACKEND_URL` — the blocky host. And they used
 *    bare paths, missing the `/api/v1` prefix Botticelli mounts them behind
 *    (`packages/integrations/src/index.ts:227`). Wrong on both counts.
 *
 * 2. `fetchAgents` and `fetchCapabilities` hardcoded
 *    `includeInactive=true&includeUnavailable=true`, which is exactly the condition
 *    Botticelli's `requireRole([Admin, SuperAdmin], { conditionFn })` tests for. A
 *    normal user got a 403 from the one endpoint carrying `isConfigured`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { INTEGRATIONS_BASE_URL, OAUTH_BACKEND_URL } from "../config.js";
import type { AuthContext } from "../settings/auth-mode.js";
import { fetchAgents, setAgentActive, setAgentAvailability } from "./agents.js";
import {
  fetchCapabilities,
  setCapabilityActive,
  setCapabilityAvailability,
} from "./capabilities.js";
import { getTenantConfig, setCustomAgentsEnabled } from "./tenant-config.js";

const INTEGRATIONS_API = `${INTEGRATIONS_BASE_URL}/api/v1`;

const ctx: AuthContext = {
  // Deliberately the blocky host: this is what getAuthContext really produces, and
  // the bug was that these functions used it.
  baseUrl: OAUTH_BACKEND_URL,
  token: "test-token",
  orgId: "org-home",
  mode: "oauth",
};

/** `fetch` accepts three input shapes; only `Request` needs unwrapping to a string. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function captureFetch(body: unknown = {}) {
  const urls: string[] = [];
  const spy: typeof globalThis.fetch = url => {
    urls.push(urlOf(url));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  globalThis.fetch = vi.fn(spy);
  return { urls };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ─── Bug 1: the wrong host ────────────────────────────────────────────────────

describe("PDEV-7332 — every integrations call targets the integrations host", () => {
  it.each([
    ["fetchAgents", () => fetchAgents(ctx), "/agents"],
    ["setAgentActive", () => setAgentActive(ctx, "a-1", true), "/agents/set-active"],
    [
      "setAgentAvailability",
      () => setAgentAvailability(ctx, "a-1", true),
      "/agents/set-availability",
    ],
    ["fetchCapabilities", () => fetchCapabilities(ctx), "/capabilities"],
    [
      "setCapabilityActive",
      () => setCapabilityActive(ctx, "c-1", true),
      "/capabilities/set-active",
    ],
    [
      "setCapabilityAvailability",
      () => setCapabilityAvailability(ctx, "c-1", true),
      "/capabilities/set-availability",
    ],
    ["getTenantConfig", () => getTenantConfig(ctx), "/tenants"],
    ["setCustomAgentsEnabled", () => setCustomAgentsEnabled(ctx, true), "/tenants/config"],
  ])("%s hits %s on the integrations host", async (_name, call, expectedPath) => {
    const { urls } = captureFetch({ config: null });

    await call();

    const url = new URL(urls[0] ?? "");
    expect(url.origin).toBe(new URL(INTEGRATIONS_BASE_URL).origin);
    expect(url.pathname).toBe(`/api/v1${expectedPath}`);
  });

  it("never falls back to ctx.baseUrl — the blocky host must not appear", async () => {
    const { urls } = captureFetch({ config: null });

    await fetchAgents(ctx);
    await fetchCapabilities(ctx);
    await getTenantConfig(ctx);

    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url.startsWith(INTEGRATIONS_API)).toBe(true);
      expect(url).not.toContain(new URL(OAUTH_BACKEND_URL).host);
    }
  });

  it("honours a hosts override, so dev/QA environments are reachable", async () => {
    const { urls } = captureFetch();
    const qaCtx: AuthContext = {
      ...ctx,
      hosts: { integrations: "https://integrations.qa.theblockbrain.ai" },
    };

    await fetchAgents(qaCtx);

    expect(urls[0]).toBe("https://integrations.qa.theblockbrain.ai/api/v1/agents?orgId=org-home");
  });

  it("keeps the /api/v1 prefix under a hosts override — the prefix is ours, not the origin's", async () => {
    const { urls } = captureFetch();

    await fetchAgents({ ...ctx, hosts: { integrations: "https://example.test/" } });

    expect(urls[0]).toBe("https://example.test/api/v1/agents?orgId=org-home");
  });

  it("leaves orgId semantics intact: targetOrgId is the query, home org is the header", async () => {
    const { urls } = captureFetch();

    await fetchAgents(ctx, "org-target");

    expect(new URL(urls[0] ?? "").searchParams.get("orgId")).toBe("org-target");
    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)["x-zitadel-org-id"]).toBe("org-home");
  });
});

// ─── Bug 2: the non-admin 403 ─────────────────────────────────────────────────

describe("PDEV-7332 — discovery does not force the admin branch", () => {
  it.each([
    ["fetchAgents", (o?: Parameters<typeof fetchAgents>[2]) => fetchAgents(ctx, undefined, o)],
    [
      "fetchCapabilities",
      (o?: Parameters<typeof fetchCapabilities>[2]) => fetchCapabilities(ctx, undefined, o),
    ],
  ])("%s sends neither admin flag by default", async (_name, call) => {
    const { urls } = captureFetch();

    await call();

    // Botticelli's conditionFn is an OR over these two being the string "true".
    // Either one present sends a normal user to the Admin/SuperAdmin branch → 403.
    const params = new URL(urls[0] ?? "").searchParams;
    expect(params.has("includeInactive")).toBe(false);
    expect(params.has("includeUnavailable")).toBe(false);
    expect(params.get("orgId")).toBe("org-home");
  });

  it.each([
    ["fetchAgents", (o?: Parameters<typeof fetchAgents>[2]) => fetchAgents(ctx, undefined, o)],
    [
      "fetchCapabilities",
      (o?: Parameters<typeof fetchCapabilities>[2]) => fetchCapabilities(ctx, undefined, o),
    ],
  ])("%s forwards the flags when an admin surface opts in", async (_name, call) => {
    const { urls } = captureFetch();

    await call({ includeInactive: true, includeUnavailable: true });

    const params = new URL(urls[0] ?? "").searchParams;
    expect(params.get("includeInactive")).toBe("true");
    expect(params.get("includeUnavailable")).toBe("true");
  });

  it("omits a flag set to false rather than sending 'false'", async () => {
    const { urls } = captureFetch();

    // The server tests the raw query for presence-and-value, so "false" would keep
    // the caller on the admin branch just as surely as "true".
    await fetchAgents(ctx, undefined, { includeInactive: false, includeUnavailable: false });

    const params = new URL(urls[0] ?? "").searchParams;
    expect(params.has("includeInactive")).toBe(false);
    expect(params.has("includeUnavailable")).toBe(false);
  });

  it("supports opting into one flag without the other", async () => {
    const { urls } = captureFetch();

    await fetchAgents(ctx, undefined, { includeInactive: true });

    const params = new URL(urls[0] ?? "").searchParams;
    expect(params.get("includeInactive")).toBe("true");
    expect(params.has("includeUnavailable")).toBe(false);
  });
});
