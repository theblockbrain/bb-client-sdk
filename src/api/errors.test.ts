import { describe, expect, it } from "vitest";
import { BB_MESSAGE_KEYS } from "../i18n/keys.js";
import { BBApiError, describeBBApiError, isRetryableBBError } from "./errors.js";

/**
 * L9 · one description and one retry rule.
 *
 * The status ladder was being rewritten per surface — `ms-outlook-addin` carries
 * three near-identical copies in one file — so they drifted. These tests pin the
 * two properties that make a shared map safe to render: it never leaks server
 * text, and `retryable` agrees with what the transport and the query client do.
 */
const http = (status: number) => new BBApiError(`API ${status}`, status, { endpoint: "/x" });

describe("describeBBApiError", () => {
  it("distinguishes a network drop from a timeout, which share statusCode 0", () => {
    const network = new BBApiError("net", 0, { kind: "network", endpoint: "/x" });
    const timeout = new BBApiError("slow", 0, { kind: "timeout", endpoint: "/x" });

    expect(describeBBApiError(network).title).toBe("No connection");
    expect(describeBBApiError(timeout).title).toBe("Timed out");
  });

  it("never renders the response body or the error message", () => {
    // The body can echo a submitted grant; this output goes on screen.
    const leaky = new BBApiError("refresh_token=rt-SECRET failed", 400, {
      endpoint: "/token",
      responseBody: { error_description: "rt-SECRET" },
    });
    const { title, detail } = describeBBApiError(leaky);

    expect(`${title} ${detail}`).not.toContain("SECRET");
    expect(`${title} ${detail}`).not.toContain("refresh_token");
  });

  it("treats 429 as retryable and every other 4xx as not", () => {
    expect(describeBBApiError(http(429)).retryable).toBe(true);
    expect(describeBBApiError(http(400)).retryable).toBe(false);
    expect(describeBBApiError(http(403)).retryable).toBe(false);
    expect(describeBBApiError(http(404)).retryable).toBe(false);
  });

  it("never retries 401 — that path belongs to the refresh flow", () => {
    // Retrying it is how a login loop starts.
    expect(describeBBApiError(http(401)).retryable).toBe(false);
    expect(describeBBApiError(http(401)).title).toBe("Signed out");
  });

  it("treats 503 as a plain 5xx, with no 'not configured' special case", () => {
    // That meaning was folklore: Botticelli emits 503 nowhere, no consumer branches
    // on it, and it entered as a comment in a README example. The realistic source
    // is infrastructure mid-rollout, which is transient.
    expect(describeBBApiError(http(503))).toEqual(describeBBApiError(http(500)));
    expect(describeBBApiError(http(503)).retryable).toBe(true);
  });

  it("agrees with the transport on every status it retries", () => {
    // The rule this whole module exists to make single. 429 and 5xx retry; the
    // rest of 4xx does not.
    for (const status of [429, 500, 502, 503]) {
      expect(isRetryableBBError(http(status))).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableBBError(http(status))).toBe(false);
    }
  });

  it("does not offer a retry for a cancelled request", () => {
    const aborted = new BBApiError("stop", 0, { kind: "aborted", endpoint: "/x" });
    expect(describeBBApiError(aborted)).toMatchObject({ title: "Cancelled", retryable: false });
  });

  it("degrades to a generic retryable description for a non-BB error", () => {
    expect(describeBBApiError(new TypeError("boom")).retryable).toBe(true);
    expect(describeBBApiError(undefined).title).toBe("Something went wrong");
  });
});

describe("isRetryableBBError", () => {
  it("agrees with the description, so the two cannot drift", () => {
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      expect(isRetryableBBError(http(status))).toBe(describeBBApiError(http(status)).retryable);
    }
  });
});

describe("BBMessageKey vocabulary", () => {
  it("covers every key describeBBApiError can emit", () => {
    // The union and the list are already proven equal at compile time; this proves the
    // producer never emits a key outside the vocabulary. It lives with the producer, not
    // with the vocabulary (PDEV-7000), so the i18n layer stays independent of `./api`.
    const cases = [
      new BBApiError("n", 0, { kind: "network", endpoint: "/x" }),
      new BBApiError("t", 0, { kind: "timeout", endpoint: "/x" }),
      new BBApiError("a", 0, { kind: "aborted", endpoint: "/x" }),
      new BBApiError("p", 0, { kind: "parse", endpoint: "/x" }),
      ...[400, 401, 403, 404, 429, 500, 503].map(s => new BBApiError("h", s, { endpoint: "/x" })),
      new TypeError("not ours"),
    ];

    for (const err of cases) {
      expect(BB_MESSAGE_KEYS).toContain(describeBBApiError(err).key);
    }
  });
});
