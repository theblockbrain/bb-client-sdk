import { describe, expect, it } from "vitest";
import {
  decodeJwtPayload,
  extractOrgIdFromClaims,
  extractProfile,
  subFromAccessToken,
} from "./jwt-claims.js";

/**
 * PDEV-7684. This module merged two decoders that had drifted apart. The ticket
 * assumed the padded (`utils/jwt.ts`) one was correct and the other was buggy for
 * never restoring base64 padding. Measured, it is the reverse:
 *
 * - The padding difference is **unreachable**. Unpadded base64 has length ≡ 0, 2
 *   or 3 (mod 4); only ≡ 1 makes `atob` fail, and no valid encoding produces it.
 *   Reintroducing the "bug" fails none of these tests, which is how it was found.
 * - The UTF-8 difference is **real**. `utils/jwt.ts` ran `JSON.parse(atob(...))`,
 *   mangling every multi-byte sequence. Adopting it, as planned, would have
 *   broken `extractProfile` for non-ASCII names.
 *
 * So the UTF-8 tests below are the ones carrying weight: reintroducing that bug
 * fails three of them.
 */

/** Encode a payload as an unsigned JWT, base64url with padding stripped (as real JWTs are). */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

describe("decodeJwtPayload — padding", () => {
  // Not a regression guard (the residue that breaks atob is unreachable) but a
  // range check: every payload length must decode, whatever its mod-4 residue.
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])(
    "decodes a payload whose base64 length %% 4 varies (padding case #%i)",
    n => {
      // Vary the payload length by one char at a time so every length-mod-4
      // residue is covered regardless of JSON overhead.
      const payload = { sub: "u", pad: "x".repeat(n) };
      expect(decodeJwtPayload(makeJwt(payload))).toMatchObject(payload);
    },
  );

  it("decodes a real-shaped token with padding stripped", () => {
    const token = makeJwt({ sub: "user-123", "urn:zitadel:iam:org:id": "org-abc" });
    // Sanity: the fixture really is unpadded, or the test proves nothing.
    expect(token.split(".")[1]).not.toContain("=");
    expect(decodeJwtPayload(token)?.sub).toBe("user-123");
  });
});

describe("decodeJwtPayload — UTF-8", () => {
  // The bug in the utils-side decoder: atob yields a binary string, so reading it
  // directly mangles every multi-byte sequence. Load-bearing for a German-first
  // customer base — `name` is rendered in the UI.
  it("preserves non-ASCII claim values", () => {
    const claims = decodeJwtPayload(makeJwt({ sub: "u1", name: "Müller", given_name: "Jörg" }));
    expect(claims?.name).toBe("Müller");
    expect(claims?.given_name).toBe("Jörg");
  });

  it("preserves characters outside the basic multilingual plane", () => {
    expect(decodeJwtPayload(makeJwt({ sub: "u1", name: "Zoë 🇩🇪" }))?.name).toBe("Zoë 🇩🇪");
  });
});

describe("decodeJwtPayload — never throws", () => {
  it.each([
    ["an sk- API key", "sk-live-abcdef"],
    ["an opaque reference token", "opaque-token-value"],
    ["empty input", ""],
    ["two segments only", "aaa.bbb"],
    ["four segments", "a.b.c.d"],
    ["malformed base64", "aaa.!!!not-base64!!!.ccc"],
    ["valid base64 that is not JSON", `aaa.${Buffer.from("not json").toString("base64url")}.ccc`],
  ])("returns null for %s", (_label, input) => {
    expect(decodeJwtPayload(input)).toBeNull();
  });
});

describe("decodeJwtPayload — the payload must be a JSON object", () => {
  /** A JWT whose payload segment is `json` verbatim, object or not. */
  const withRawPayload = (json: string): string => {
    const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");
    return `${b64url('{"alg":"none"}')}.${b64url(json)}.sig`;
  };

  // RFC 7519 §7.2 requires the payload to be a JSON object; it does not make it
  // one. The declared return type says `Record<string, unknown> | null`, but
  // `JSON.parse` will happily produce a number, a string, an array or a boolean,
  // and every one of those used to be returned under that type. A consumer's
  // `if (!payload) throw` then catches only `null` — which is how `ms-word-addin`
  // could commit an authenticated session whose profile was the string "hacked",
  // with no `sub` and no error anywhere.
  it.each([
    ["a number", "123"],
    ["a string", '"hacked"'],
    ["an array", "[1,2]"],
    ["a boolean", "true"],
    ["JSON null", "null"],
  ])("returns null for a payload that decodes to %s", (_label, json) => {
    expect(decodeJwtPayload(withRawPayload(json))).toBeNull();
  });

  it("still returns the claims for a genuine object payload", () => {
    expect(decodeJwtPayload(withRawPayload('{"sub":"user-1"}'))).toEqual({ sub: "user-1" });
  });
});

describe("subFromAccessToken", () => {
  it("reads the sub claim", () => {
    expect(subFromAccessToken(makeJwt({ sub: "user-sub-123" }))).toBe("user-sub-123");
  });

  it.each([
    ["a JWT with no sub", makeJwt({ foo: "bar" })],
    ["a JWT with an empty sub", makeJwt({ sub: "" })],
    ["a JWT with a non-string sub", makeJwt({ sub: 42 })],
    ["an API key", "sk-live-abcdef"],
  ])("returns null for %s", (_label, token) => {
    expect(subFromAccessToken(token)).toBeNull();
  });
});

describe("extractOrgIdFromClaims", () => {
  it("prefers the direct org claim", () => {
    expect(
      extractOrgIdFromClaims({
        "urn:zitadel:iam:org:id": "org-direct",
        "urn:zitadel:iam:user:resourceowner:id": "org-owner",
      }),
    ).toBe("org-direct");
  });

  it("falls back to the resource owner", () => {
    expect(extractOrgIdFromClaims({ "urn:zitadel:iam:user:resourceowner:id": "org-owner" })).toBe(
      "org-owner",
    );
  });

  it("falls back to the first key of the first project role", () => {
    expect(
      extractOrgIdFromClaims({
        "urn:zitadel:iam:org:project:roles": { admin: { "org-from-roles": "primary" } },
      }),
    ).toBe("org-from-roles");
  });

  it("never uses blockbrain:grants, whose leading id is a project not an org", () => {
    expect(extractOrgIdFromClaims({ "blockbrain:grants": ["proj-123:admin"] })).toBeNull();
  });

  it("returns null when no claim carries an org", () => {
    expect(extractOrgIdFromClaims({ sub: "u1" })).toBeNull();
  });
});

describe("extractProfile", () => {
  it("reads the profile from the id token", () => {
    const profile = extractProfile(
      makeJwt({
        sub: "u1",
        email: "a@b.c",
        name: "Jörg Müller",
        given_name: "Jörg",
        family_name: "Müller",
        "urn:zitadel:iam:org:id": "org-1",
      }),
    );
    expect(profile).toEqual({
      sub: "u1",
      email: "a@b.c",
      name: "Jörg Müller",
      given_name: "Jörg",
      family_name: "Müller",
      orgId: "org-1",
    });
  });

  it("falls back to the access token for orgId", () => {
    const profile = extractProfile(
      makeJwt({ sub: "u1" }),
      makeJwt({ "urn:zitadel:iam:org:id": "org-from-access" }),
    );
    expect(profile.orgId).toBe("org-from-access");
  });

  it("tolerates an opaque access token in the fallback", () => {
    // Reference tokens are not JWTs — expected, must not throw.
    expect(extractProfile(makeJwt({ sub: "u1" }), "opaque-reference-token").orgId).toBeNull();
  });

  it("returns an empty sub rather than throwing on a junk id token", () => {
    expect(extractProfile("not-a-jwt")).toEqual({
      sub: "",
      email: undefined,
      name: undefined,
      given_name: undefined,
      family_name: undefined,
      orgId: null,
    });
  });
});
