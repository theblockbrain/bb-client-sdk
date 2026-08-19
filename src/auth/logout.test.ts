import { describe, expect, it } from "vitest";
import type { Transporter, TransportRequest, TransportResponse } from "../api/transport.js";
import { logout } from "./logout.js";

/**
 * Before this existed, signing out was a local discard: the SDK had no call to
 * `/oauth/v2/revoke` and no RP-initiated logout anywhere, so the refresh token
 * issued under `offline_access` stayed valid at the IdP for its full lifetime. A
 * user signing out on a shared or stolen device had not actually ended anything.
 *
 * Two properties are pinned here, and they pull in opposite directions. Revocation
 * must actually be attempted, against the refresh token, because that is the
 * credential with a long life and revoking it drops the whole grant. And a failed
 * revocation must never block the local sign-out, because refusing to log someone
 * out because the network is down is strictly worse than the token outliving the
 * session. The result says which happened rather than hiding it.
 */

function stub(res: { status?: number; ok?: boolean; throws?: Error }) {
  const sent: TransportRequest[] = [];
  const transport: Transporter = {
    send(req) {
      sent.push(req);
      if (res.throws) return Promise.reject(res.throws);
      const full: TransportResponse = {
        status: res.status ?? 200,
        ok: res.ok ?? (res.status ?? 200) < 400,
        headers: {},
        json: <T>() => Promise.resolve({} as T),
        text: () => Promise.resolve(""),
      };
      return Promise.resolve(full);
    },
  };
  return { transport, sent, last: () => sent[sent.length - 1] };
}

/** The form-encoded body a revoke call carries. */
function form(req: TransportRequest): URLSearchParams {
  if (typeof req.body !== "string") throw new Error("expected a form-encoded string body");
  return new URLSearchParams(req.body);
}

describe("logout", () => {
  it("revokes the refresh token, because that is what drops the grant", async () => {
    const { transport, sent, last } = stub({});

    await logout({ clientId: "app-1", refreshToken: "rt-abc", accessToken: "at-xyz", transport });

    expect(sent).toHaveLength(1);
    expect(last().method).toBe("POST");
    expect(last().path).toBe("/oauth/v2/revoke");
    expect(form(last()).get("token")).toBe("rt-abc");
    expect(form(last()).get("token_type_hint")).toBe("refresh_token");
    expect(form(last()).get("client_id")).toBe("app-1");
  });

  it("falls back to the access token when there is no refresh token", async () => {
    const { transport, last } = stub({});

    await logout({ clientId: "app-1", accessToken: "at-xyz", transport });

    expect(form(last()).get("token")).toBe("at-xyz");
    expect(form(last()).get("token_type_hint")).toBe("access_token");
  });

  it("reports success when the IdP accepts the revocation", async () => {
    const { transport } = stub({ status: 200 });

    await expect(logout({ clientId: "app-1", refreshToken: "rt", transport })).resolves.toEqual({
      revoked: true,
    });
  });

  it("does not reject when the network is down, so sign-out still completes", async () => {
    const { transport } = stub({ throws: new Error("network down") });

    await expect(logout({ clientId: "app-1", refreshToken: "rt", transport })).resolves.toEqual({
      revoked: false,
    });
  });

  it("does not reject when the IdP refuses the revocation", async () => {
    const { transport } = stub({ status: 503 });

    await expect(logout({ clientId: "app-1", refreshToken: "rt", transport })).resolves.toEqual({
      revoked: false,
    });
  });

  it("makes no request when there is nothing to revoke", async () => {
    const { transport, sent } = stub({});

    const result = await logout({ clientId: "app-1", transport });

    expect(sent).toHaveLength(0);
    expect(result).toEqual({ revoked: false });
  });

  it("sends the revocation form-encoded, as RFC 7009 requires", async () => {
    const { transport, last } = stub({});

    await logout({ clientId: "app-1", refreshToken: "rt", transport });

    expect(last().headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("honours a self-hosted revoke endpoint", async () => {
    const { transport, last } = stub({});

    await logout({
      clientId: "app-1",
      refreshToken: "rt",
      transport,
      revokeEndpoint: "https://auth.dev.theblockbrain.ai/oauth/v2/revoke",
    });

    expect(last().path).toBe("/oauth/v2/revoke");
  });
  it("resolves rather than rejects when the endpoint override is malformed", async () => {
    // `logout()` documents "Always resolves. Clear local auth state regardless of the
    // result." A `new URL()` on a bad override threw synchronously, before the guarded
    // path — so the one contract a sign-out path must keep was broken by a caller typo,
    // and the surface would never clear local state.
    await expect(
      logout({ clientId: "c", refreshToken: "rt", revokeEndpoint: "not-a-url" }),
    ).resolves.toEqual({ revoked: false });
  });
});
