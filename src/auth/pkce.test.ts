/**
 * Security regression tests: the PKCE `code_verifier` must NEVER appear in the
 * authorize URL.
 *
 * CWE-200. A verifier that travels in the `state` parameter is written into
 * browser history, the Referer header and the IdP's access logs — which makes
 * an intercepted authorization code redeemable and defeats the only thing PKCE
 * is for.
 *
 * PDEV-7684: this file is a port of `test/auth/pkce-state-separation.test.ts`,
 * which was written against `bun:test` and lived outside `src/`. `vitest.config.ts`
 * only includes `src/**` — so it had NEVER run in CI. It sat there reading as
 * coverage for the exact defect that then shipped to a live surface
 * (`ms-outlook-addin` still calls the removed `encodePKCEState`). Rewritten for
 * vitest and moved here so `npm test` enforces it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityAdapter } from "../adapters/identity.js";
import { AUTH_SCOPES } from "../config.js";
import type { BrowserRedirectOptions } from "./browser-redirect.js";
import { beginBrowserLogin, completeBrowserLogin } from "./browser-redirect.js";
import { login } from "./login.js";
import { ORG_SCOPE_PREFIX } from "./org-scope.js";
import { generateChallenge, generateStateNonce, generateVerifier } from "./pkce.js";

vi.mock("./tokens.js", () => ({
  exchangeCode: vi.fn(() =>
    Promise.resolve({
      access_token: "at",
      id_token: "it",
      refresh_token: "rt",
      expires_in: 3600,
      token_type: "Bearer",
    }),
  ),
  computeExpiration: (expiresIn: number) => Date.now() + expiresIn * 1000,
}));

// Mocked so the flow under test does not depend on decoding the placeholder
// id_token. Spreads the real module rather than replacing it: jwt-claims also
// exports `subFromAccessToken` (used by settings/auth-mode.ts and api/messages.ts)
// and a bare factory would blank those out for any transitive importer.
vi.mock("./jwt-claims.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./jwt-claims.js")>()),
  extractProfile: () => ({ sub: "u1", orgId: "org1" }),
}));

const VERIFIER_KEY = (nonce: string) => `bb_pkce_verifier:${nonce}`;

/**
 * Point `window.location.href` at a capture variable. jsdom's real `location`
 * cannot be assigned a cross-origin URL, and the assignment is the thing under
 * test, so the property is replaced outright.
 */
function captureNavigation(): { get url(): string } {
  let captured = "";
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      get href() {
        return captured;
      },
      set href(value: string) {
        captured = value;
      },
      search: "",
      pathname: "/",
    },
  });
  return {
    get url() {
      return captured;
    },
  };
}

/** Put the page on an OAuth callback URL. */
function onCallbackUrl(search: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { search, pathname: "/", href: "" },
  });
}

const REDIRECT_URI = "https://app.example.com/callback";

/**
 * Drive `beginBrowserLogin` far enough to capture the authorize URL it navigates
 * to. The call itself never settles, by design: the real page unloads.
 */
async function browserAuthorizeUrl(opts: BrowserRedirectOptions): Promise<URL> {
  const nav = captureNavigation();
  void beginBrowserLogin(opts);
  await vi.waitFor(() => expect(nav.url).not.toBe(""));
  return new URL(nav.url);
}

/** The `scope` parameter of an authorize URL, split back into a list. */
function scopesOf(url: URL): string[] {
  return (url.searchParams.get("scope") ?? "").split(" ");
}

/** Run `login()` far enough to capture the authorize URL, then abandon it. */
async function dialogAuthorizeUrl(options: Parameters<typeof login>[1]): Promise<URL> {
  let captured = "";
  const identity: IdentityAdapter = {
    getRedirectUri: () => REDIRECT_URI,
    launchOAuthFlow: (url: string) => {
      captured = url;
      return Promise.reject(new Error("stop here"));
    },
  };
  await login(identity, options).catch(() => undefined);
  return new URL(captured);
}

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("generateStateNonce", () => {
  it("produces a base64url string with no padding or non-url characters", () => {
    expect(generateStateNonce()).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("produces a unique value per call", () => {
    expect(generateStateNonce()).not.toBe(generateStateNonce());
  });

  it("is independent of generateVerifier", () => {
    // Same entropy source, deliberately different values — if these were ever
    // derived from one another, the state param would leak the verifier.
    expect(generateStateNonce()).not.toBe(generateVerifier());
  });
});

describe("generateVerifier / generateChallenge", () => {
  it("emits a 43-char base64url verifier (RFC 7636, 32 bytes)", () => {
    // NOT crypto.randomUUID() — 36 chars with hyphens is non-compliant.
    const verifier = generateVerifier();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("derives an S256 challenge that is not the verifier itself", async () => {
    // A `plain` challenge would equal the verifier and offer no protection.
    const verifier = generateVerifier();
    const challenge = await generateChallenge(verifier);
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("is deterministic for a given verifier", async () => {
    const verifier = generateVerifier();
    expect(await generateChallenge(verifier)).toBe(await generateChallenge(verifier));
  });
});

describe("beginBrowserLogin — the verifier must not reach the URL", () => {
  it("sends an opaque nonce as `state` and keeps the verifier in sessionStorage", async () => {
    const nav = captureNavigation();

    // Never resolves — the real call navigates the page away.
    void beginBrowserLogin({
      clientId: "test-client",
      redirectUri: "https://app.example.com/callback",
    });
    await vi.waitFor(() => expect(nav.url).not.toBe(""));

    const url = new URL(nav.url);
    const stateParam = url.searchParams.get("state") ?? "";
    expect(stateParam.length).toBeGreaterThan(0);

    // The old encodePKCEState produced base64url of `{"verifier":"…"}`. If that
    // ever comes back, this decodes to an object instead of throwing.
    let decodedState: unknown = null;
    try {
      decodedState = JSON.parse(atob(stateParam.replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      decodedState = null; // expected: an opaque nonce is not JSON
    }
    expect(decodedState).toBeNull();

    const storedVerifier = sessionStorage.getItem(VERIFIER_KEY(stateParam));
    expect(storedVerifier).not.toBeNull();
    // The whole point, asserted against the raw URL string rather than a
    // parsed param, so it also catches the verifier leaking into any other
    // query parameter or the fragment.
    expect(nav.url).not.toContain(storedVerifier);
  });

  it("requests S256 and never `plain`", async () => {
    const nav = captureNavigation();

    void beginBrowserLogin({ clientId: "c", redirectUri: "https://app.example.com/callback" });
    await vi.waitFor(() => expect(nav.url).not.toBe(""));

    const url = new URL(nav.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("gives concurrent tabs isolated verifier entries", async () => {
    // Per-nonce keys, not one fixed key — otherwise a second tab clobbers the
    // first and the first login fails its CSRF guard on return.
    const first = captureNavigation();
    void beginBrowserLogin({ clientId: "c", redirectUri: "https://app.example.com/callback" });
    await vi.waitFor(() => expect(first.url).not.toBe(""));
    const firstState = new URL(first.url).searchParams.get("state") ?? "";

    const second = captureNavigation();
    void beginBrowserLogin({ clientId: "c", redirectUri: "https://app.example.com/callback" });
    await vi.waitFor(() => expect(second.url).not.toBe(""));
    const secondState = new URL(second.url).searchParams.get("state") ?? "";

    expect(firstState).not.toBe(secondState);
    expect(sessionStorage.getItem(VERIFIER_KEY(firstState))).not.toBeNull();
    expect(sessionStorage.getItem(VERIFIER_KEY(secondState))).not.toBeNull();
  });
});

/**
 * PDEV-7369. `beginBrowserLogin` had no `orgId`, so a surface supporting both the
 * dialog flow and the browser fallback had to hand-build
 * `urn:zitadel:iam:org:id:<id>` for the browser half. `ms-word-addin` shipped that
 * asymmetry: the dialog path passed `orgId`, the fallback did not, and a multi-org
 * developer would have authenticated into their DEFAULT organization and seen
 * another tenant's data. Nothing fails on that path, so review was the only guard.
 */
describe("beginBrowserLogin — organization pinning", () => {
  it("omits any org scope when no orgId is given (org as output)", async () => {
    const url = await browserAuthorizeUrl({ clientId: "c", redirectUri: REDIRECT_URI });

    expect(scopesOf(url).some(s => s.startsWith(ORG_SCOPE_PREFIX))).toBe(false);
    expect(scopesOf(url)).toEqual([...AUTH_SCOPES]);
  });

  it("appends the org scope WITHOUT dropping the defaults (org as input)", async () => {
    // The whole point of the option: hand-building this scope means also
    // remembering to re-list offline_access, and forgetting it kills refresh.
    const url = await browserAuthorizeUrl({
      clientId: "c",
      redirectUri: REDIRECT_URI,
      orgId: "org-42",
    });

    const scopes = scopesOf(url);
    expect(scopes).toContain(`${ORG_SCOPE_PREFIX}org-42`);
    for (const preserved of AUTH_SCOPES) expect(scopes).toContain(preserved);
    expect(scopes).toContain("offline_access");
  });

  it("layers the org scope on top of a caller-supplied scope list", async () => {
    const url = await browserAuthorizeUrl({
      clientId: "c",
      redirectUri: REDIRECT_URI,
      scopes: ["openid", "offline_access"],
      orgId: "org-42",
    });

    // Appended, not substituted for the caller's list.
    expect(scopesOf(url)).toEqual(["openid", "offline_access", `${ORG_SCOPE_PREFIX}org-42`]);
  });

  it("does not duplicate an org scope the caller already listed", async () => {
    const url = await browserAuthorizeUrl({
      clientId: "c",
      redirectUri: REDIRECT_URI,
      scopes: ["openid", `${ORG_SCOPE_PREFIX}org-42`],
      orgId: "org-42",
    });

    expect(scopesOf(url).filter(s => s === `${ORG_SCOPE_PREFIX}org-42`)).toHaveLength(1);
  });

  it("ignores a blank orgId rather than emitting a valueless scope", async () => {
    // `urn:zitadel:iam:org:id:` with nothing after it is a malformed scope that
    // Zitadel rejects, so an empty form field must not produce one.
    const url = await browserAuthorizeUrl({
      clientId: "c",
      redirectUri: REDIRECT_URI,
      orgId: "   ",
    });

    expect(scopesOf(url).some(s => s.startsWith(ORG_SCOPE_PREFIX))).toBe(false);
  });

  it("keeps the org scope out of every parameter except `scope`", async () => {
    // Zitadel reads the org from the scope list. An org that travelled as its own
    // query parameter would look pinned to a reviewer and be ignored by the IdP.
    const url = await browserAuthorizeUrl({
      clientId: "c",
      redirectUri: REDIRECT_URI,
      orgId: "org-42",
    });

    for (const [name, value] of url.searchParams) {
      if (name === "scope") continue;
      expect(value).not.toContain("org-42");
    }
  });
});

/**
 * Cross-path parity. Both entry points build their own authorize URL, and both now
 * pin an organization, so the two can drift: that drift IS the PDEV-7369 defect.
 * These cases pin the two `scope` parameters to each other so a change to one path
 * that is not made to the other fails here rather than in a customer's tenant.
 */
describe("organization pinning is identical on both PKCE paths", () => {
  const cases: Array<{ name: string; scopes?: readonly string[]; orgId?: string }> = [
    { name: "no org at all" },
    { name: "a pinned org on the default scopes", orgId: "org-42" },
    {
      name: "a pinned org on a custom scope list",
      scopes: ["openid", "offline_access"],
      orgId: "org-42",
    },
    {
      name: "an org the caller already listed",
      scopes: ["openid", `${ORG_SCOPE_PREFIX}org-42`],
      orgId: "org-42",
    },
    { name: "a blank org", orgId: "   " },
  ];

  for (const { name, scopes, orgId } of cases) {
    it(`agrees on the scope list for ${name}`, async () => {
      const browser = await browserAuthorizeUrl({
        clientId: "c",
        redirectUri: REDIRECT_URI,
        scopes,
        orgId,
      });
      const dialog = await dialogAuthorizeUrl({ clientId: "c", scopes, orgId });

      expect(scopesOf(browser)).toEqual(scopesOf(dialog));
    });
  }
});

describe("completeBrowserLogin — CSRF guard and verifier lifetime", () => {
  it("rejects a state nonce it never issued", async () => {
    onCallbackUrl("?code=abc&state=tampered-nonce");

    await expect(
      completeBrowserLogin({ clientId: "c", redirectUri: "https://app.example.com/callback" }),
    ).rejects.toThrow(/No stored PKCE verifier for state nonce/);
  });

  it("rejects a callback with no state at all", async () => {
    onCallbackUrl("?code=abc");

    await expect(
      completeBrowserLogin({ clientId: "c", redirectUri: "https://app.example.com/callback" }),
    ).rejects.toThrow(/Missing OAuth state/);
  });

  it("completes and clears the verifier when the nonce matches", async () => {
    const nonce = generateStateNonce();
    sessionStorage.setItem(VERIFIER_KEY(nonce), generateVerifier());
    onCallbackUrl(`?code=authcode&state=${nonce}`);

    const result = await completeBrowserLogin({
      clientId: "c",
      redirectUri: "https://app.example.com/callback",
    });

    expect(result.isCallback).toBe(true);
    expect(result.access_token).toBe("at");
    // Single-use: a replayed callback must not find it again.
    expect(sessionStorage.getItem(VERIFIER_KEY(nonce))).toBeNull();
  });

  it("clears the verifier even when the token exchange throws", async () => {
    const { exchangeCode } = await import("./tokens.js");
    vi.mocked(exchangeCode).mockRejectedValueOnce(new Error("token exchange failed"));

    const nonce = generateStateNonce();
    sessionStorage.setItem(VERIFIER_KEY(nonce), generateVerifier());
    onCallbackUrl(`?code=authcode&state=${nonce}`);

    await expect(
      completeBrowserLogin({ clientId: "c", redirectUri: "https://app.example.com/callback" }),
    ).rejects.toThrow("token exchange failed");

    // Cleared eagerly BEFORE the exchange, so a failed attempt cannot be retried
    // with the same verifier.
    expect(sessionStorage.getItem(VERIFIER_KEY(nonce))).toBeNull();
  });

  it("reports a normal page load as not-a-callback", async () => {
    onCallbackUrl("");

    const result = await completeBrowserLogin({
      clientId: "c",
      redirectUri: "https://app.example.com/callback",
    });

    expect(result.isCallback).toBe(false);
    expect(result.access_token).toBe("");
  });

  it("surfaces an OAuth error from the IdP", async () => {
    onCallbackUrl("?error=access_denied&error_description=User%20said%20no");

    await expect(
      completeBrowserLogin({ clientId: "c", redirectUri: "https://app.example.com/callback" }),
    ).rejects.toThrow(/access_denied/);
  });

  it("exchanges the code identically whether or not an orgId is passed", async () => {
    // `orgId` is accepted here only because the options interface is shared with
    // `beginBrowserLogin`, and it must stay inert: the authorization-code token
    // request carries no `scope` (RFC 6749 §4.1.3), the granted scope was fixed at
    // the authorize step, and `refreshTokens` omits scope for the same reason
    // (Zitadel rejects custom scopes on a token request). If someone ever threads
    // an org into the exchange, this fails and forces the question.
    const { exchangeCode } = await import("./tokens.js");

    const runWith = async (orgId?: string) => {
      const nonce = generateStateNonce();
      sessionStorage.setItem(VERIFIER_KEY(nonce), "fixed-verifier-for-comparison");
      onCallbackUrl(`?code=authcode&state=${nonce}`);
      await completeBrowserLogin({ clientId: "c", redirectUri: REDIRECT_URI, orgId });
      return vi.mocked(exchangeCode).mock.calls.at(-1);
    };

    const without = await runWith(undefined);
    const with_ = await runWith("org-42");

    expect(with_).toEqual(without);
    // And nothing that looks like an org URN reached the token endpoint.
    expect(JSON.stringify(with_)).not.toContain(ORG_SCOPE_PREFIX);
  });
});
