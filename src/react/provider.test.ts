import { describe, expect, it } from "vitest";
import { BBApiError } from "../api/index.js";
import { bbShouldRetryQuery } from "./provider.js";

describe("bbShouldRetryQuery", () => {
  it("never retries client errors (4xx)", () => {
    expect(bbShouldRetryQuery(0, new BBApiError("bad request", 400))).toBe(false);
    expect(bbShouldRetryQuery(0, new BBApiError("not found", 404))).toBe(false);
    expect(bbShouldRetryQuery(0, new BBApiError("unprocessable", 422))).toBe(false);
  });

  it("never retries 401 — that path is owned by the auth-refresh flow", () => {
    expect(bbShouldRetryQuery(0, new BBApiError("unauthorized", 401))).toBe(false);
  });

  it("retries 5xx and network errors up to three times", () => {
    expect(bbShouldRetryQuery(0, new BBApiError("server", 503))).toBe(true);
    expect(bbShouldRetryQuery(0, new Error("network"))).toBe(true);
    expect(bbShouldRetryQuery(2, new Error("network"))).toBe(true);
    expect(bbShouldRetryQuery(3, new Error("network"))).toBe(false);
  });
});
