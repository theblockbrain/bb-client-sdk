import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityAdapter } from "../adapters/identity.js";
import type { AnalyticsAdapter, AnalyticsIdentity } from "../analytics/index.js";
import { resetAnalyticsAdapter, setAnalyticsAdapter } from "../analytics/index.js";
import { login } from "./login.js";

interface RecordedEvent {
  event: string;
  props: Record<string, unknown>;
  identity?: AnalyticsIdentity;
}

function makeRecorder() {
  const events: RecordedEvent[] = [];
  /** Ordered log of every adapter call, so identity binding can be checked against emission order. */
  const calls: string[] = [];
  const adapter: AnalyticsAdapter = {
    track: (event, props, identity) => {
      events.push({ event, props, identity });
      calls.push(`track:${event}`);
    },
    captureError: () => {},
    identify: distinctId => {
      calls.push(`identify:${distinctId}`);
    },
    group: orgId => {
      calls.push(`group:${orgId}`);
    },
  };
  return { adapter, events, calls };
}

/** Minimal IdentityAdapter whose OAuth flow resolves/rejects on demand. */
function makeIdentity(launch: (url: string) => Promise<string>): IdentityAdapter {
  return {
    getRedirectUri: () => "https://app.example.com/callback",
    launchOAuthFlow: launch,
  };
}

/** Encode a minimal unsigned JWT with the given payload (base64url). */
function makeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

const OPTIONS = { clientId: "test-client" };

afterEach(() => {
  resetAnalyticsAdapter();
  vi.unstubAllGlobals();
});

describe("login telemetry", () => {
  it("emits sign_in_started at entry and sign_in_completed with identity on completion", async () => {
    const { adapter, events, calls } = makeRecorder();
    setAnalyticsAdapter(adapter);

    const idToken = makeJwt({ sub: "user-sub-123", "urn:zitadel:iam:org:id": "org-abc" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      // The transport buffers via text() so its deadline covers reading the body.
      text: async () => JSON.stringify({ access_token: "at", id_token: idToken, expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // launchOAuthFlow must echo back the state nonce the SDK generated; capture it.
    const identity = makeIdentity(async (url: string) => {
      const state = new URL(url).searchParams.get("state") ?? "";
      return `https://app.example.com/callback?code=abc&state=${state}`;
    });

    const result = await login(identity, OPTIONS);

    expect(result.profile.sub).toBe("user-sub-123");
    expect(result.orgId).toBe("org-abc");

    expect(events[0]).toMatchObject({ event: "sign_in_started", props: { method: "oidc" } });
    const success = events.find(e => e.event === "sign_in_completed");
    expect(success?.props.method).toBe("oidc");
    expect(typeof success?.props.latency_ms).toBe("number");
    expect(success?.identity).toEqual({ distinctId: "user-sub-123", orgId: "org-abc" });
    expect(events.some(e => e.event === "sign_in_failed")).toBe(false);

    // Identity is bound BEFORE sign_in_completed, so every later (identity-less) event
    // is attributed to this user + tenant rather than the anonymous device id.
    expect(calls).toEqual([
      "track:sign_in_started",
      "identify:user-sub-123",
      "group:org-abc",
      "track:sign_in_completed",
    ]);
  });

  it("binds the user but not a group when the token carries no org", async () => {
    const { adapter, events, calls } = makeRecorder();
    setAnalyticsAdapter(adapter);

    const idToken = makeJwt({ sub: "user-sub-123" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({ access_token: "at", id_token: idToken, expires_in: 3600 }),
      }),
    );

    const identity = makeIdentity(async (url: string) => {
      const state = new URL(url).searchParams.get("state") ?? "";
      return `https://app.example.com/callback?code=abc&state=${state}`;
    });

    const result = await login(identity, OPTIONS);

    expect(result.orgId).toBeNull();
    expect(calls).toEqual([
      "track:sign_in_started",
      "identify:user-sub-123",
      "track:sign_in_completed",
    ]);
    // A null orgId must not travel as a property either.
    expect(events.find(e => e.event === "sign_in_completed")?.identity).toEqual({
      distinctId: "user-sub-123",
    });
  });

  it("binds no identity when login fails", async () => {
    const { adapter, calls } = makeRecorder();
    setAnalyticsAdapter(adapter);

    const identity = makeIdentity(async () => {
      throw new Error("user cancelled");
    });

    await expect(login(identity, OPTIONS)).rejects.toThrow("user cancelled");

    expect(calls).toEqual(["track:sign_in_started", "track:sign_in_failed"]);
  });

  it("reports stage 'launch' when the OAuth flow throws", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    const identity = makeIdentity(async () => {
      throw new Error("user cancelled");
    });

    await expect(login(identity, OPTIONS)).rejects.toThrow("user cancelled");

    const failed = events.find(e => e.event === "sign_in_failed");
    expect(failed?.props).toEqual({ method: "oidc", stage: "launch" });
  });

  it("reports stage 'launch' (not 'parse') when the redirect URL is missing", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    const identity = makeIdentity(async () => "");

    await expect(login(identity, OPTIONS)).rejects.toThrow(/No redirect URL/);

    const failed = events.find(e => e.event === "sign_in_failed");
    expect(failed?.props).toEqual({ method: "oidc", stage: "launch" });
  });

  it("reports stage 'parse' when the returned state does not round-trip (CSRF)", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    const identity = makeIdentity(
      async () => "https://app.example.com/callback?code=abc&state=tampered",
    );

    await expect(login(identity, OPTIONS)).rejects.toThrow(/State mismatch/);

    const failed = events.find(e => e.event === "sign_in_failed");
    expect(failed?.props).toEqual({ method: "oidc", stage: "parse" });
  });

  it("re-throws the original error unchanged even when no adapter is registered", async () => {
    const identity = makeIdentity(async () => {
      throw new Error("boom");
    });

    await expect(login(identity, OPTIONS)).rejects.toThrow("boom");
  });
});

/**
 * PDEV-7684. Two surfaces disagreed about organization scope and both were
 * right: `ms-outlook-addin` treats the org as an OUTPUT (never asks, reads the
 * claim), `ms-word-addin` treats it as an INPUT (pins the login via
 * `urn:zitadel:iam:org:id:<id>`). `LoginOptions.orgId` makes that a first-class
 * choice instead of a hand-concatenated URN, and makes it additive so pinning
 * cannot displace `offline_access`.
 */
describe("login scopes", () => {
  /** Run login far enough to capture the authorize URL, then abandon it. */
  async function capturedScopes(options: Parameters<typeof login>[1]): Promise<string[]> {
    let authorizeUrl = "";
    const identity = makeIdentity((url: string) => {
      authorizeUrl = url;
      return Promise.reject(new Error("stop here"));
    });
    await login(identity, options).catch(() => undefined);
    return (new URL(authorizeUrl).searchParams.get("scope") ?? "").split(" ");
  }

  it("sends the default scope set when nothing is overridden", async () => {
    const scopes = await capturedScopes(OPTIONS);
    expect(scopes).toEqual(["openid", "profile", "email", "offline_access", "blockbrain:grants"]);
  });

  it("omits any org scope when no orgId is given (org-as-output)", async () => {
    const scopes = await capturedScopes(OPTIONS);
    expect(scopes.some(s => s.startsWith("urn:zitadel:iam:org:id:"))).toBe(false);
  });

  it("appends the org scope WITHOUT dropping the defaults (org-as-input)", async () => {
    // The whole point of the option: hand-building this scope means also
    // remembering to re-list offline_access, and forgetting it kills refresh.
    const scopes = await capturedScopes({ ...OPTIONS, orgId: "org-42" });

    expect(scopes).toContain("urn:zitadel:iam:org:id:org-42");
    expect(scopes).toContain("offline_access");
    expect(scopes).toContain("blockbrain:grants");
  });

  it("layers the org scope on top of a custom scope list", async () => {
    const scopes = await capturedScopes({
      ...OPTIONS,
      scopes: ["openid", "offline_access"],
      orgId: "org-42",
    });
    expect(scopes).toEqual(["openid", "offline_access", "urn:zitadel:iam:org:id:org-42"]);
  });

  it("does not duplicate an org scope the caller already listed", async () => {
    const scopes = await capturedScopes({
      ...OPTIONS,
      scopes: ["openid", "urn:zitadel:iam:org:id:org-42"],
      orgId: "org-42",
    });
    expect(scopes.filter(s => s === "urn:zitadel:iam:org:id:org-42")).toHaveLength(1);
  });

  it("ignores a blank orgId rather than emitting a valueless scope", async () => {
    // `urn:zitadel:iam:org:id:` with nothing after it is a malformed scope that
    // Zitadel rejects — an empty form field must not produce one.
    const scopes = await capturedScopes({ ...OPTIONS, orgId: "   " });
    expect(scopes.some(s => s.startsWith("urn:zitadel:iam:org:id:"))).toBe(false);
  });
});

/**
 * Two authorize-request parameters the flow was missing.
 *
 * `nonce` closes an OIDC gap: the OAuth `state` nonce was generated and verified
 * correctly, so CSRF on the redirect was covered, but nothing bound the returned ID
 * token to the request that asked for it. OIDC Core section 3.1.2.1 makes `nonce`
 * the mechanism for that binding.
 *
 * `login_hint` is what carries the address the user already typed into the
 * email-first screen, so they are not asked for it a second time on the login page.
 * Without it the "hidden" tenant resolve is still hidden, but the user re-types
 * their e-mail immediately afterwards, which is the exact papercut the flow exists
 * to remove.
 */
describe("login authorize parameters", () => {
  /** Run login far enough to capture the authorize URL, then abandon it. */
  async function capturedUrl(options: Parameters<typeof login>[1]): Promise<URL> {
    let authorizeUrl = "";
    const identity = makeIdentity((url: string) => {
      authorizeUrl = url;
      return Promise.reject(new Error("stop here"));
    });
    await login(identity, options).catch(() => undefined);
    return new URL(authorizeUrl);
  }

  it("sends a nonce so the ID token is bound to this request", async () => {
    const url = await capturedUrl(OPTIONS);
    const nonce = url.searchParams.get("nonce");
    expect(nonce).toBeTruthy();
    // Same generator as the state nonce: 32 random bytes, base64url.
    expect((nonce ?? "").length).toBeGreaterThanOrEqual(43);
  });

  it("uses a different value for nonce and state", async () => {
    // Reusing one value for both would make the CSRF token guessable from the ID
    // token, and vice versa.
    const url = await capturedUrl(OPTIONS);
    expect(url.searchParams.get("nonce")).not.toBe(url.searchParams.get("state"));
  });

  it("issues a fresh nonce on every login attempt", async () => {
    const first = await capturedUrl(OPTIONS);
    const second = await capturedUrl(OPTIONS);
    expect(first.searchParams.get("nonce")).not.toBe(second.searchParams.get("nonce"));
  });

  it("passes the already-typed address through as login_hint", async () => {
    const url = await capturedUrl({ ...OPTIONS, loginHint: "ada@acme.com" });
    expect(url.searchParams.get("login_hint")).toBe("ada@acme.com");
  });

  it("omits login_hint when no address was collected", async () => {
    const url = await capturedUrl(OPTIONS);
    expect(url.searchParams.has("login_hint")).toBe(false);
  });

  it("forces re-authentication when the caller asks for prompt=login", async () => {
    // The shared-workstation case: `login_hint` alone can complete silently against
    // the provider's existing session, landing the second person in the first
    // person's account.
    const url = await capturedUrl({ ...OPTIONS, loginHint: "ada@acme.com", prompt: "login" });
    expect(url.searchParams.get("prompt")).toBe("login");
  });

  it("omits prompt entirely when the caller does not ask for one", async () => {
    // A returning user must keep the instant path.
    const url = await capturedUrl(OPTIONS);
    expect(url.searchParams.has("prompt")).toBe(false);
  });

  it("ignores a blank login_hint rather than sending an empty parameter", async () => {
    const url = await capturedUrl({ ...OPTIONS, loginHint: "   " });
    expect(url.searchParams.has("login_hint")).toBe(false);
  });
});

/**
 * Sending a nonce and never checking it back is theatre, so this verifies the
 * claim. The asymmetry between the two cases is deliberate and worth stating.
 *
 * A MISMATCH is unambiguous: the ID token was minted for a different authorize
 * request than the one this client started, which is the substitution attack the
 * nonce exists to catch. It fails hard.
 *
 * An ABSENT claim is not the same signal. OIDC Core requires the provider to echo
 * the nonce when one was sent, but this has never been exercised against our
 * deployed Zitadel, and hard-failing on it would turn an unverified assumption into
 * a total sign-in outage across six surfaces on the day it shipped. So it is
 * allowed by default and gated behind `requireNonce` for a surface that has
 * confirmed its provider echoes it. That default is a knowing trade-off, not an
 * oversight, and it should be flipped once verified.
 */
describe("login nonce verification", () => {
  /** A login whose token response carries the given ID-token claims. */
  async function loginReturning(
    claims: (nonce: string) => Record<string, unknown>,
    options: Parameters<typeof login>[1] = OPTIONS,
  ) {
    let sentNonce = "";
    const identity = makeIdentity(async (url: string) => {
      const params = new URL(url).searchParams;
      sentNonce = params.get("nonce") ?? "";
      return `https://app.example.com/callback?code=abc&state=${params.get("state")}`;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({
            access_token: "at",
            id_token: makeJwt({ sub: "u1", ...claims(sentNonce) }),
            expires_in: 3600,
          }),
      })),
    );
    return login(identity, options);
  }

  it("accepts an ID token whose nonce matches the request", async () => {
    const result = await loginReturning(nonce => ({ nonce }));
    expect(result.profile.sub).toBe("u1");
  });

  it("rejects an ID token minted for a different request", async () => {
    await expect(loginReturning(() => ({ nonce: "some-other-nonce" }))).rejects.toThrow(/nonce/i);
  });

  it("allows a missing nonce claim by default, because the provider is unverified", async () => {
    const result = await loginReturning(() => ({}));
    expect(result.profile.sub).toBe("u1");
  });

  it("rejects a missing nonce claim when the surface opts into strictness", async () => {
    await expect(loginReturning(() => ({}), { ...OPTIONS, requireNonce: true })).rejects.toThrow(
      /nonce/i,
    );
  });
});
