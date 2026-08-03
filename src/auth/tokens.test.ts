import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transporter, TransportRequest, TransportResponse } from "../api/transport.js";
import { exchangeCode, refreshTokens } from "./tokens.js";

/**
 * PDEV-7338/7339 review findings. `tokens.ts` had **no** test coverage, which is
 * how both of these survived:
 *
 * 1. `postToken` split the endpoint into origin + `pathname` and dropped any
 *    query component. RFC 6749 §3.2 permits the token endpoint to carry one and
 *    requires it to be retained, so an IdP or proxy using one silently lost it.
 * 2. The raw response body of a *failed* token call reached both a thrown message
 *    and a `console.error` — the latter sitting directly under a comment warning
 *    that the body can echo the grant. A consumer stringifying the error into
 *    Sentry publishes whatever the server put there (invariant D).
 *
 * The bar these tests hold: server-controlled text must not reach the message or
 * the log, while the one useful diagnostic (the §5.2 code) survives.
 */

/** Capture the request; reply with whatever the case needs. */
function stub(res: Partial<TransportResponse> & { body?: unknown }) {
  const sent: TransportRequest[] = [];
  const transport: Transporter = {
    send(req) {
      sent.push(req);
      const full: TransportResponse = {
        status: res.status ?? 200,
        ok: res.ok ?? true,
        headers: {},
        json: <T>() => {
          if (res.json) return res.json<T>();
          return Promise.resolve(res.body as T);
        },
        text: () => Promise.resolve(JSON.stringify(res.body ?? {})),
      };
      return Promise.resolve(full);
    },
  };
  return { transport, sent, last: () => sent[sent.length - 1] };
}

/**
 * The request body as text. `TransportRequest.body` is `string | FormData`, and a
 * bare `String()` on the latter yields `"[object FormData]"` — a token grant is
 * always form-encoded, so anything else is the test lying to itself.
 */
function bodyText(req: TransportRequest): string {
  if (typeof req.body !== "string") throw new Error("expected a form-encoded string body");
  return req.body;
}

/** The Error a call rejected with — fails loudly if it resolved instead. */
async function rejection(call: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await call;
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof Error)) throw new Error("expected the call to reject");
  return caught;
}

const TOKENS = {
  access_token: "at",
  id_token: "it",
  expires_in: 3600,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("postToken — endpoint decomposition", () => {
  it("retains a query component on the token endpoint (RFC 6749 §3.2)", async () => {
    const s = stub({ body: TOKENS });
    await exchangeCode(
      "code",
      "verifier",
      "https://app.example.test/cb",
      "client",
      "https://idp.example.test/oauth/v2/token?tenant=acme&v=2",
      s.transport,
    );

    expect(s.last()).toMatchObject({
      host: "auth",
      method: "POST",
      path: "/oauth/v2/token",
      query: { tenant: "acme", v: "2" },
    });
  });

  it("omits query entirely when the endpoint has none", async () => {
    const s = stub({ body: TOKENS });
    await exchangeCode(
      "code",
      "verifier",
      "https://app.example.test/cb",
      "client",
      "https://idp.example.test/oauth/v2/token",
      s.transport,
    );

    expect(s.last().path).toBe("/oauth/v2/token");
    expect(s.last().query).toBeUndefined();
  });

  it("sends the grant form-encoded in the body, never in the query", async () => {
    const s = stub({ body: TOKENS });
    await exchangeCode(
      "the-code",
      "the-verifier",
      "https://app.example.test/cb",
      "client",
      "https://idp.example.test/oauth/v2/token?tenant=acme",
      s.transport,
    );

    const req = s.last();
    expect(req.headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(bodyText(req)).toContain("code_verifier=the-verifier");
    // The verifier must never be a query parameter — it would land in access logs.
    expect(JSON.stringify(req.query ?? {})).not.toContain("the-verifier");
  });
});

describe("failed token calls — what the error is allowed to say", () => {
  const LEAKY_BODY = {
    error: "invalid_grant",
    error_description: "grant failed for refresh_token=rt-SECRET",
    submitted: { code_verifier: "verifier-SECRET", refresh_token: "rt-SECRET" },
  };

  it("exchangeCode reports status + the allowlisted code, not the body", async () => {
    const s = stub({ status: 400, ok: false, body: LEAKY_BODY });

    await expect(
      exchangeCode("c", "v", "https://app.example.test/cb", "client", undefined, s.transport),
    ).rejects.toThrow("Token exchange failed: 400 (invalid_grant)");
  });

  it("exchangeCode leaks neither the description nor the echoed grant", async () => {
    const s = stub({ status: 400, ok: false, body: LEAKY_BODY });

    const err = await rejection(
      exchangeCode("c", "v", "https://app.example.test/cb", "client", undefined, s.transport),
    );

    expect(err.message).not.toContain("SECRET");
    expect(err.message).not.toContain("error_description");
    expect(err.message).not.toContain("verifier");
  });

  it("drops an `error` value outside the RFC 6749 §5.2 set", async () => {
    // An allowlist, not a passthrough — otherwise the AS controls the message.
    const s = stub({
      status: 400,
      ok: false,
      body: { error: "sensitive internal detail: token=SECRET" },
    });

    const err = await rejection(
      exchangeCode("c", "v", "https://app.example.test/cb", "client", undefined, s.transport),
    );

    expect(err.message).toBe("Token exchange failed: 400");
    expect(err.message).not.toContain("SECRET");
  });

  it("survives a non-JSON error body without masking the failure", async () => {
    const s = stub({
      status: 502,
      ok: false,
      json: () => Promise.reject(new Error("not json")),
    });

    await expect(
      exchangeCode("c", "v", "https://app.example.test/cb", "client", undefined, s.transport),
    ).rejects.toThrow("Token exchange failed: 502");
  });

  it("refreshTokens keeps the body out of both the log and the error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = stub({ status: 400, ok: false, body: LEAKY_BODY });

    await expect(refreshTokens("rt-SECRET", "client", undefined, s.transport)).rejects.toThrow(
      "Token refresh failed: 400 (invalid_grant)",
    );

    const line = logged.mock.calls.map(args => args.join(" ")).join("\n");
    expect(line).toContain("400 (invalid_grant)");
    expect(line).not.toContain("SECRET");
    expect(line).not.toContain("error_description");
  });

  it("refreshTokens omits scope on the refresh grant", async () => {
    // Zitadel rejects custom scopes on refresh — regression guard, not a nicety.
    const s = stub({ body: TOKENS });
    await refreshTokens("rt", "client", undefined, s.transport);

    expect(bodyText(s.last())).not.toContain("scope");
  });
});
