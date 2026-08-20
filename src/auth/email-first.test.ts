import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityAdapter } from "../adapters/identity.js";
import type { Transporter, TransportResponse } from "../api/transport.js";
import { loginEmailFirst } from "./email-first.js";
import type { TenantOption } from "./tenant-discovery.js";

/**
 * The orchestration behind the email-first diagram: resolve the tenant behind an
 * address, ask the user only when the answer is ambiguous, then run the ordinary
 * PKCE login pinned to whatever tenant came out.
 *
 * The picker is supplied as a callback rather than rendered here on purpose. The
 * SDK owns the protocol and the ordering — which is the security-relevant part and
 * must be identical on all six surfaces — while each surface owns the rendering,
 * because a 320px Outlook taskpane and a phone screen have nothing in common.
 */

/** Encode a minimal unsigned JWT (base64url). */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

/** Captures the authorize URL the login built, then completes the flow. */
function makeIdentity() {
  const seen: string[] = [];
  const identity: IdentityAdapter = {
    getRedirectUri: () => "https://app.example.com/callback",
    launchOAuthFlow: (url: string) => {
      seen.push(url);
      const params = new URL(url).searchParams;
      return Promise.resolve(
        `https://app.example.com/callback?code=abc&state=${params.get("state")}`,
      );
    },
  };
  return { identity, authorizeUrl: () => new URL(seen[seen.length - 1]), launches: seen };
}

/** A transporter that answers the discovery call with the given tenants. */
function discoveryStub(tenants: unknown, status = 200) {
  const transport: Transporter = {
    send: () => {
      const res: TransportResponse = {
        status,
        ok: status < 400,
        headers: {},
        json: <T>() => Promise.resolve({ body: tenants } as T),
        text: () => Promise.resolve(""),
      };
      return Promise.resolve(res);
    },
  };
  return transport;
}

const ACME = { domain: "acme.blockbrain.ai", zitadelOrgId: "111", tenantName: "Acme" };
const ACME_EU = { domain: "acme-eu.blockbrain.ai", zitadelOrgId: "222", tenantName: "Acme EU" };

/** Stub the token exchange so login() can complete. */
function stubTokenExchange() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          access_token: "at",
          id_token: makeJwt({ sub: "u1" }),
          expires_in: 3600,
        }),
    }),
  );
}

const OPTIONS = { clientId: "test-client" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loginEmailFirst", () => {
  it("skips the picker and pins the org when exactly one tenant matches", async () => {
    stubTokenExchange();
    const { identity, authorizeUrl } = makeIdentity();
    const onTenantChoice = vi.fn();

    const result = await loginEmailFirst(identity, "ada@acme.com", {
      ...OPTIONS,
      onTenantChoice,
      discovery: { transport: discoveryStub([ACME]) },
    });

    expect(onTenantChoice).not.toHaveBeenCalled();
    expect(result.tenant?.orgId).toBe("111");
    expect(authorizeUrl().searchParams.get("scope")).toContain("urn:zitadel:iam:org:id:111");
  });

  it("forwards the typed address so the user is not asked for it twice", async () => {
    stubTokenExchange();
    const { identity, authorizeUrl } = makeIdentity();

    await loginEmailFirst(identity, "ada@acme.com", {
      ...OPTIONS,
      onTenantChoice: () => ACME_TENANT,
      discovery: { transport: discoveryStub([ACME]) },
    });

    expect(authorizeUrl().searchParams.get("login_hint")).toBe("ada@acme.com");
  });

  it("asks the surface to choose when more than one tenant matches", async () => {
    stubTokenExchange();
    const { identity, authorizeUrl } = makeIdentity();
    const onTenantChoice = vi.fn((tenants: TenantOption[]) => tenants[1]);

    const result = await loginEmailFirst(identity, "ada@acme.com", {
      ...OPTIONS,
      onTenantChoice,
      discovery: { transport: discoveryStub([ACME, ACME_EU]) },
    });

    expect(onTenantChoice).toHaveBeenCalledTimes(1);
    expect(onTenantChoice.mock.calls[0][0]).toHaveLength(2);
    expect(result.tenant?.orgId).toBe("222");
    expect(authorizeUrl().searchParams.get("scope")).toContain("urn:zitadel:iam:org:id:222");
  });

  it("accepts an async picker, because rendering a choice is asynchronous", async () => {
    stubTokenExchange();
    const { identity } = makeIdentity();

    const result = await loginEmailFirst(identity, "ada@acme.com", {
      ...OPTIONS,
      onTenantChoice: tenants => Promise.resolve(tenants[0]),
      discovery: { transport: discoveryStub([ACME, ACME_EU]) },
    });

    expect(result.tenant?.orgId).toBe("111");
  });

  /**
   * Failing here would be wrong twice over. It would turn the UI into an
   * account-existence oracle (a distinct error for an address we do not know), and
   * it would lock out a legitimate user who exists in the instance's default
   * organization but in no tenant of ours. Signing in unpinned lets Zitadel resolve
   * the home org, which is the pre-existing org-as-output behaviour.
   */
  it("signs in unpinned rather than failing when no tenant matches", async () => {
    stubTokenExchange();
    const { identity, authorizeUrl } = makeIdentity();
    const onTenantChoice = vi.fn();

    const result = await loginEmailFirst(identity, "nobody@nowhere.test", {
      ...OPTIONS,
      onTenantChoice,
      discovery: { transport: discoveryStub([], 404) },
    });

    expect(onTenantChoice).not.toHaveBeenCalled();
    expect(result.tenant).toBeNull();
    expect(authorizeUrl().searchParams.get("scope")).not.toContain("urn:zitadel:iam:org:id:");
  });

  it("refuses a picker result that was not one of the offered tenants", async () => {
    stubTokenExchange();
    const { identity } = makeIdentity();

    // A surface returning a hand-built object would pin the login to a tenant the
    // user was never offered, which is a tenant-routing decision made by a bug.
    await expect(
      loginEmailFirst(identity, "ada@acme.com", {
        ...OPTIONS,
        onTenantChoice: () => ({ orgId: "999", tenantName: "Elsewhere", domain: "x" }),
        discovery: { transport: discoveryStub([ACME, ACME_EU]) },
      }),
    ).rejects.toThrow(/not one of/i);
  });

  it("does not start a login when discovery itself failed", async () => {
    stubTokenExchange();
    const { identity, launches } = makeIdentity();

    await expect(
      loginEmailFirst(identity, "ada@acme.com", {
        ...OPTIONS,
        onTenantChoice: () => ACME_TENANT,
        discovery: { transport: discoveryStub([], 500) },
      }),
    ).rejects.toThrow();
    expect(launches).toHaveLength(0);
  });

  it("propagates a cancelled picker without starting a login", async () => {
    stubTokenExchange();
    const { identity, launches } = makeIdentity();

    await expect(
      loginEmailFirst(identity, "ada@acme.com", {
        ...OPTIONS,
        onTenantChoice: () => Promise.reject(new Error("user dismissed the picker")),
        discovery: { transport: discoveryStub([ACME, ACME_EU]) },
      }),
    ).rejects.toThrow(/dismissed/);
    expect(launches).toHaveLength(0);
  });
});

const ACME_TENANT: TenantOption = {
  orgId: "111",
  tenantName: "Acme",
  domain: "acme.blockbrain.ai",
};
