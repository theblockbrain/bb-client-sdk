/**
 * Security regression tests: PKCE code_verifier must NEVER appear in the authorize URL.
 *
 * CWE-200: the verifier travelling in the `state` parameter would leak it into
 * browser history and IdP logs, defeating PKCE's interception defence.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

// --- minimal sessionStorage stub (not available in Bun's default env) ------
const _store: Record<string, string> = {};
const sessionStorageStub = {
  getItem: (key: string) => _store[key] ?? null,
  setItem: (key: string, value: string) => {
    _store[key] = value;
  },
  removeItem: (key: string) => {
    delete _store[key];
  },
};

// Provide Web APIs that browser-redirect.ts expects.
(globalThis as unknown as Record<string, unknown>).sessionStorage = sessionStorageStub;
(globalThis as unknown as Record<string, unknown>).document = { title: "" };
(globalThis as unknown as Record<string, unknown>).window = {
  location: { href: "" },
  history: { replaceState: () => {} },
};

// Stub out the token exchange so completeBrowserLogin can run end-to-end
// without hitting a real IdP.
mock.module("../../src/auth/tokens.js", () => ({
  exchangeCode: async () => ({
    access_token: "at",
    id_token: "it",
    refresh_token: "rt",
    expires_in: 3600,
    token_type: "Bearer",
  }),
  computeExpiration: (exp: number) => Date.now() + exp * 1000,
}));

mock.module("../../src/auth/jwt.js", () => ({
  extractProfile: () => ({ sub: "u1", orgId: "org1" }),
}));

mock.module("../../src/config.js", () => ({
  AUTH_SCOPES: ["openid", "profile"],
  AUTHORIZE_ENDPOINT: "https://auth.example.com/authorize",
  TOKEN_ENDPOINT: "https://auth.example.com/token",
}));

import { beginBrowserLogin, completeBrowserLogin } from "../../src/auth/browser-redirect.js";
import { generateStateNonce, generateVerifier } from "../../src/auth/pkce.js";

// ---------------------------------------------------------------------------

describe("generateStateNonce", () => {
  it("produces a non-empty base64url string", () => {
    const nonce = generateStateNonce();
    expect(typeof nonce).toBe("string");
    expect(nonce.length).toBeGreaterThan(0);
    // Must be base64url (no +, /, or =)
    expect(nonce).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("produces unique values on each call", () => {
    const a = generateStateNonce();
    const b = generateStateNonce();
    expect(a).not.toBe(b);
  });

  it("is independent from generateVerifier", () => {
    const nonce = generateStateNonce();
    const verifier = generateVerifier();
    expect(nonce).not.toBe(verifier);
  });
});

describe("beginBrowserLogin — verifier is NOT in the authorize URL", () => {
  let capturedUrl = "";

  beforeEach(() => {
    // Clear sessionStorage between runs
    for (const k of Object.keys(_store)) delete _store[k];
    capturedUrl = "";
    // Capture the URL the code would navigate to
    (globalThis as unknown as Record<string, unknown>).window = {
      location: {
        get href() {
          return capturedUrl;
        },
        set href(v: string) {
          capturedUrl = v;
        },
      },
      history: { replaceState: () => {} },
    };
  });

  it("stores the verifier in sessionStorage under a per-nonce key — not in the URL state param", async () => {
    // beginBrowserLogin never resolves (navigates away), so we race it.
    const loginPromise = beginBrowserLogin({
      clientId: "test-client",
      redirectUri: "https://app.example.com/callback",
    });

    // Give the async work a tick to run before the page-navigation promise hangs.
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    const url = new URL(capturedUrl);
    const stateParam = url.searchParams.get("state") ?? "";

    // 1. state must be set
    expect(stateParam.length).toBeGreaterThan(0);

    // 2. state must be an opaque nonce — NOT a base64-encoded JSON with a verifier
    let decodedState: unknown;
    try {
      const base64 = stateParam.replace(/-/g, "+").replace(/_/g, "/");
      decodedState = JSON.parse(atob(base64));
    } catch {
      decodedState = null; // expected — opaque nonce won't parse as JSON
    }
    expect(decodedState).toBeNull();

    // 3. The raw state value must not contain the verifier that is in sessionStorage
    const verifierKey = `bb_pkce_verifier:${stateParam}`;
    const storedVerifier = sessionStorage.getItem(verifierKey);
    expect(storedVerifier).not.toBeNull(); // verifier IS stored
    expect(stateParam).not.toContain(storedVerifier!); // but NOT in the URL

    // 4. The raw authorize URL string must not contain the verifier at all
    expect(capturedUrl).not.toContain(storedVerifier!);

    // Clean up the hanging promise
    loginPromise.catch(() => {});
  });
});

describe("completeBrowserLogin — full round-trip", () => {
  beforeEach(() => {
    for (const k of Object.keys(_store)) delete _store[k];
  });

  it("rejects when no verifier entry exists for the returned state (CSRF guard)", async () => {
    (globalThis as unknown as Record<string, unknown>).window = {
      location: { search: "?code=abc&state=tampered-nonce" },
      history: { replaceState: () => {} },
    };

    await expect(
      completeBrowserLogin({ clientId: "c", redirectUri: "https://app.example.com/callback" }),
    ).rejects.toThrow(/PKCE verifier.*state nonce|refreshed mid-auth|CSRF/i);
  });

  it("completes successfully when state nonce matches the stored verifier", async () => {
    const nonce = generateStateNonce();
    const verifier = generateVerifier();
    sessionStorage.setItem(`bb_pkce_verifier:${nonce}`, verifier);

    (globalThis as unknown as Record<string, unknown>).window = {
      location: { search: `?code=authcode&state=${nonce}` },
      history: { replaceState: () => {} },
    };

    const result = await completeBrowserLogin({
      clientId: "c",
      redirectUri: "https://app.example.com/callback",
    });

    expect(result.isCallback).toBe(true);
    expect(result.access_token).toBe("at");

    // Verifier entry must be cleared after successful exchange
    expect(sessionStorage.getItem(`bb_pkce_verifier:${nonce}`)).toBeNull();
  });

  it("clears the verifier entry even when token exchange throws", async () => {
    // Override the mock to throw for this test
    mock.module("../../src/auth/tokens.js", () => ({
      exchangeCode: async () => {
        throw new Error("token exchange failed");
      },
      computeExpiration: (exp: number) => Date.now() + exp * 1000,
    }));

    const nonce = generateStateNonce();
    const verifier = generateVerifier();
    sessionStorage.setItem(`bb_pkce_verifier:${nonce}`, verifier);

    (globalThis as unknown as Record<string, unknown>).window = {
      location: { search: `?code=authcode&state=${nonce}` },
      history: { replaceState: () => {} },
    };

    await expect(
      completeBrowserLogin({ clientId: "c", redirectUri: "https://app.example.com/callback" }),
    ).rejects.toThrow("token exchange failed");

    // Verifier was cleared eagerly before exchange — still gone
    expect(sessionStorage.getItem(`bb_pkce_verifier:${nonce}`)).toBeNull();
  });
});
