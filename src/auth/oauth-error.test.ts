import { describe, expect, it } from "vitest";
import { isOAuthDenied, OAuthError, readOAuthError } from "./oauth-error.js";

const params = (search: string) => new URLSearchParams(search);

describe("readOAuthError", () => {
  it("returns null for a successful authorization response", () => {
    expect(readOAuthError(params("?code=abc&state=nonce"))).toBeNull();
  });

  it("keeps the code as a field, not only in the message", () => {
    const failure = readOAuthError(params("?error=access_denied&state=nonce"));
    expect(failure).toBeInstanceOf(OAuthError);
    expect(failure?.code).toBe("access_denied");
  });

  it("keeps the provider description available", () => {
    const failure = readOAuthError(
      params("?error=invalid_scope&error_description=Scope+not+allowed"),
    );
    expect(failure?.description).toBe("Scope not allowed");
  });

  it("reads a missing or empty description as null", () => {
    expect(readOAuthError(params("?error=server_error"))?.description).toBeNull();
    expect(
      readOAuthError(params("?error=server_error&error_description="))?.description,
    ).toBeNull();
  });
});

describe("OAuthError message", () => {
  it("does not end in a dangling separator when there is no description", () => {
    // The previous formatting produced "Auth error: access_denied — " and that
    // string reached a consumer's UI as a label.
    const failure = new OAuthError("access_denied", null);
    expect(failure.message).toBe("OAuth access_denied");
    expect(failure.message.trimEnd()).toBe(failure.message);
  });

  it("includes the description when there is one", () => {
    expect(new OAuthError("invalid_scope", "Scope not allowed").message).toBe(
      "OAuth invalid_scope: Scope not allowed",
    );
  });

  it("is an Error with a stable name", () => {
    const failure = new OAuthError("server_error");
    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).toBe("OAuthError");
  });
});

describe("isOAuthDenied", () => {
  it("is true only for access_denied", () => {
    expect(isOAuthDenied(new OAuthError("access_denied"))).toBe(true);
    expect(isOAuthDenied(new OAuthError("unauthorized_client"))).toBe(false);
  });

  it("is false for anything that is not an OAuthError", () => {
    expect(isOAuthDenied(new Error("OAuth access_denied"))).toBe(false);
    expect(isOAuthDenied("access_denied")).toBe(false);
    expect(isOAuthDenied(null)).toBe(false);
  });
});
