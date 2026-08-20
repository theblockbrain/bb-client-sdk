import { describe, expect, it } from "vitest";
import type { Transporter, TransportRequest, TransportResponse } from "../api/transport.js";
import { discoverTenants } from "./tenant-discovery.js";

/**
 * Discovery is the one call in the whole flow that runs before anybody is
 * authenticated, which makes it the single largest new attack surface the
 * email-first design introduces. These tests pin the two properties that follow
 * from that.
 *
 * First, an unknown address must be indistinguishable from a known one at the call
 * site: blocky answers 404 `Email not found` for an address it has never seen and
 * 200 for one it has, so mapping only the 200 through would hand every caller an
 * account-existence oracle in the shape of a thrown exception. It resolves to an
 * empty list instead, and the caller writes one branch.
 *
 * Second, a real transport failure must still be a failure. Swallowing a network
 * error into "no tenants" would strand the user on the picker with no explanation
 * and would look identical to an unknown e-mail.
 */

/** A transporter that replies with one canned response and records what it was sent. */
function stub(res: { status?: number; ok?: boolean; body?: unknown; throws?: Error }) {
  const sent: TransportRequest[] = [];
  const transport: Transporter = {
    send(req) {
      sent.push(req);
      if (res.throws) return Promise.reject(res.throws);
      const full: TransportResponse = {
        status: res.status ?? 200,
        ok: res.ok ?? (res.status ?? 200) < 400,
        headers: {},
        json: <T>() => Promise.resolve(res.body as T),
        text: () => Promise.resolve(JSON.stringify(res.body ?? {})),
      };
      return Promise.resolve(full);
    },
  };
  return { transport, sent, last: () => sent[sent.length - 1] };
}

const twoTenants = {
  code: 200,
  key: null,
  body: [
    { domain: "acme.blockbrain.ai", zitadelOrgId: "111", tenantName: "Acme" },
    { domain: "acme-eu.blockbrain.ai", zitadelOrgId: "222", tenantName: "Acme EU" },
  ],
};

describe("discoverTenants", () => {
  it("asks blocky for the tenants behind an e-mail", async () => {
    const { transport, last } = stub({ body: twoTenants });

    await discoverTenants("ada@acme.com", { transport });

    expect(last().host).toBe("blocky");
    expect(last().path).toBe("/tenant-via-email/list-tenant");
    expect(last().method).toBe("GET");
    expect(last().query?.email).toBe("ada@acme.com");
  });

  it("unwraps blocky's response envelope into plain tenant options", async () => {
    const { transport } = stub({ body: twoTenants });

    const tenants = await discoverTenants("ada@acme.com", { transport });

    expect(tenants).toEqual([
      { orgId: "111", tenantName: "Acme", domain: "acme.blockbrain.ai" },
      { orgId: "222", tenantName: "Acme EU", domain: "acme-eu.blockbrain.ai" },
    ]);
  });

  it("accepts a bare array, because not every blocky route wraps its body", async () => {
    const { transport } = stub({ body: twoTenants.body });

    const tenants = await discoverTenants("ada@acme.com", { transport });

    expect(tenants).toHaveLength(2);
    expect(tenants[0].orgId).toBe("111");
  });

  it("treats an unknown e-mail as no tenants rather than an error", async () => {
    const { transport } = stub({ status: 404, body: { code: 404, key: "EMAIL_NOT_FOUND" } });

    await expect(discoverTenants("nobody@nowhere.test", { transport })).resolves.toEqual([]);
  });

  it("still fails loudly when the call itself fails", async () => {
    const { transport } = stub({ throws: new Error("network down") });

    await expect(discoverTenants("ada@acme.com", { transport })).rejects.toThrow(/network down/);
  });

  it("fails loudly on a server error, which is not the same as an unknown e-mail", async () => {
    const { transport } = stub({ status: 500, body: {} });

    await expect(discoverTenants("ada@acme.com", { transport })).rejects.toThrow();
  });

  it("sends the shared API key when the surface was given one", async () => {
    const { transport, last } = stub({ body: twoTenants });

    await discoverTenants("ada@acme.com", { transport, apiKey: "k123" });

    expect(last().headers?.["x-api-key"]).toBe("k123");
  });

  it("sends no API key header when none was supplied", async () => {
    const { transport, last } = stub({ body: twoTenants });

    await discoverTenants("ada@acme.com", { transport });

    expect(last().headers?.["x-api-key"]).toBeUndefined();
  });

  it("drops a tenant with no organization id instead of returning an unusable option", async () => {
    // Selecting one of these would pin the login to `undefined` and fail late,
    // inside Zitadel, with an error the user cannot act on.
    const { transport } = stub({
      body: { body: [{ domain: "d", tenantName: "Broken" }, twoTenants.body[0]] },
    });

    const tenants = await discoverTenants("ada@acme.com", { transport });

    expect(tenants).toEqual([{ orgId: "111", tenantName: "Acme", domain: "acme.blockbrain.ai" }]);
  });

  it("passes an abort signal through so a slow lookup can be cancelled", async () => {
    const { transport, last } = stub({ body: twoTenants });
    const controller = new AbortController();

    await discoverTenants("ada@acme.com", { transport, signal: controller.signal });

    expect(last().signal).toBe(controller.signal);
  });

  it("rejects a blank e-mail without making a request", async () => {
    const { transport, sent } = stub({ body: twoTenants });

    await expect(discoverTenants("   ", { transport })).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});
