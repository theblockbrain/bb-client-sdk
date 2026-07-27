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
  it("emits auth_started at entry and auth_success with identity on completion", async () => {
    const { adapter, events, calls } = makeRecorder();
    setAnalyticsAdapter(adapter);

    const idToken = makeJwt({ sub: "user-sub-123", "urn:zitadel:iam:org:id": "org-abc" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "at",
        id_token: idToken,
        expires_in: 3600,
      }),
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

    expect(events[0]).toMatchObject({ event: "auth_started", props: { mode: "oauth" } });
    const success = events.find(e => e.event === "auth_success");
    expect(success?.props.mode).toBe("oauth");
    expect(typeof success?.props.latencyMs).toBe("number");
    expect(success?.identity).toEqual({ distinctId: "user-sub-123", orgId: "org-abc" });
    expect(events.some(e => e.event === "auth_failed")).toBe(false);

    // Identity is bound BEFORE auth_success, so every later (identity-less) event
    // is attributed to this user + tenant rather than the anonymous device id.
    expect(calls).toEqual([
      "track:auth_started",
      "identify:user-sub-123",
      "group:org-abc",
      "track:auth_success",
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
        json: async () => ({ access_token: "at", id_token: idToken, expires_in: 3600 }),
      }),
    );

    const identity = makeIdentity(async (url: string) => {
      const state = new URL(url).searchParams.get("state") ?? "";
      return `https://app.example.com/callback?code=abc&state=${state}`;
    });

    const result = await login(identity, OPTIONS);

    expect(result.orgId).toBeNull();
    expect(calls).toEqual(["track:auth_started", "identify:user-sub-123", "track:auth_success"]);
    // A null orgId must not travel as a property either.
    expect(events.find(e => e.event === "auth_success")?.identity).toEqual({
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

    expect(calls).toEqual(["track:auth_started", "track:auth_failed"]);
  });

  it("reports stage 'launch' when the OAuth flow throws", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    const identity = makeIdentity(async () => {
      throw new Error("user cancelled");
    });

    await expect(login(identity, OPTIONS)).rejects.toThrow("user cancelled");

    const failed = events.find(e => e.event === "auth_failed");
    expect(failed?.props).toEqual({ mode: "oauth", stage: "launch" });
  });

  it("reports stage 'launch' (not 'parse') when the redirect URL is missing", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    const identity = makeIdentity(async () => "");

    await expect(login(identity, OPTIONS)).rejects.toThrow(/No redirect URL/);

    const failed = events.find(e => e.event === "auth_failed");
    expect(failed?.props).toEqual({ mode: "oauth", stage: "launch" });
  });

  it("reports stage 'parse' when the returned state does not round-trip (CSRF)", async () => {
    const { adapter, events } = makeRecorder();
    setAnalyticsAdapter(adapter);

    const identity = makeIdentity(
      async () => "https://app.example.com/callback?code=abc&state=tampered",
    );

    await expect(login(identity, OPTIONS)).rejects.toThrow(/State mismatch/);

    const failed = events.find(e => e.event === "auth_failed");
    expect(failed?.props).toEqual({ mode: "oauth", stage: "parse" });
  });

  it("re-throws the original error unchanged even when no adapter is registered", async () => {
    const identity = makeIdentity(async () => {
      throw new Error("boom");
    });

    await expect(login(identity, OPTIONS)).rejects.toThrow("boom");
  });
});
