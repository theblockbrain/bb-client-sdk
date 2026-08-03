import { afterEach, describe, expect, it, vi } from "vitest";
import { login } from "../auth/login.js";
import {
  createOfficeIdentityAdapter,
  type OfficeDialog,
  type OfficeDialogEventArgs,
  type OfficeGlobal,
} from "./office.js";

vi.mock("../auth/tokens.js", () => ({
  exchangeCode: vi.fn(() =>
    Promise.resolve({
      access_token: "at",
      id_token: "it",
      refresh_token: "rt",
      expires_in: 3600,
      token_type: "Bearer",
    }),
  ),
  computeExpiration: (seconds: number) => Date.now() + seconds * 1000,
}));

// Mocked so the flow under test does not depend on decoding the placeholder
// id_token. Spreads the real module rather than replacing it: jwt-claims also
// exports `subFromAccessToken` (used by settings/auth-mode.ts and api/messages.ts)
// and a bare factory would blank those out for any transitive importer.
vi.mock("../auth/jwt-claims.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../auth/jwt-claims.js")>()),
  extractProfile: () => ({ sub: "u1", orgId: "org1" }),
}));

/**
 * PDEV-7684. The defect this adapter replaces: both Office add-ins base64'd the
 * PKCE verifier into the OAuth `state` parameter to carry it across the dialog
 * boundary, putting it in the authorize URL, browser history and IdP logs
 * (CWE-200).
 *
 * The load-bearing test here is `login()` end-to-end through the adapter,
 * asserting the verifier reaches neither the authorize URL nor the dialog —
 * only the taskpane's token exchange ever sees it.
 */

const MESSAGE_RECEIVED = "dialogMessageReceived";
const EVENT_RECEIVED = "dialogEventReceived";
const FAILED = "failed"; // string enum in Office.js, verified against the real namespace

interface FakeOffice {
  office: OfficeGlobal;
  /** The URL the dialog was opened with. */
  openedWith: () => string;
  /** Simulate the callback page calling `messageParent`. */
  postMessage: (message: string) => void;
  /** Simulate a dialog-level event (e.g. the user closing it). */
  postEvent: (error: number) => void;
  closeCount: () => number;
}

/** A test double for the slice of Office.js the adapter uses. */
function fakeOffice(options: { failToOpen?: boolean } = {}): FakeOffice {
  const handlers = new Map<string, (args: OfficeDialogEventArgs) => void>();
  let opened = "";
  let closes = 0;

  const dialog: OfficeDialog = {
    addEventHandler: (eventType, handler) => {
      handlers.set(eventType, handler);
    },
    close: () => {
      closes += 1;
    },
  };

  const office: OfficeGlobal = {
    context: {
      ui: {
        displayDialogAsync: (startAddress, _opts, callback) => {
          opened = startAddress;
          if (options.failToOpen) {
            callback({ status: FAILED, value: dialog, error: { message: "blocked" } });
            return;
          }
          callback({ status: "succeeded", value: dialog });
        },
      },
    },
    EventType: {
      DialogMessageReceived: MESSAGE_RECEIVED,
      DialogEventReceived: EVENT_RECEIVED,
    },
    AsyncResultStatus: { Failed: FAILED },
  };

  return {
    office,
    openedWith: () => opened,
    postMessage: message => handlers.get(MESSAGE_RECEIVED)?.({ message }),
    postEvent: error => handlers.get(EVENT_RECEIVED)?.({ error }),
    closeCount: () => closes,
  };
}

// Outlook's real shape: fragment-free, as RFC 6749 §3.1.2 requires.
const REDIRECT_URI = "https://addin.example.com/taskpane.html";

function adapterFor(fake: FakeOffice) {
  return createOfficeIdentityAdapter({ office: fake.office, redirectUri: REDIRECT_URI });
}

afterEach(() => vi.unstubAllGlobals());

describe("createOfficeIdentityAdapter", () => {
  it("returns the caller's redirect URI verbatim", () => {
    // Each add-in has its own host, separately registered in Zitadel — the SDK
    // must not try to derive this.
    expect(adapterFor(fakeOffice()).getRedirectUri()).toBe(REDIRECT_URI);
  });

  it("opens the authorize URL in a non-iframed dialog", async () => {
    // An IdP sends X-Frame-Options / frame-ancestors, so an iframed dialog
    // renders blank. This default is load-bearing, not cosmetic.
    const fake = fakeOffice();
    let capturedOptions: Record<string, unknown> = {};
    const spy = vi.spyOn(fake.office.context.ui, "displayDialogAsync");

    const pending = adapterFor(fake).launchOAuthFlow("https://idp.example.com/authorize?x=1");
    fake.postMessage(`${REDIRECT_URI}?code=abc&state=n1`);
    await pending;

    capturedOptions = spy.mock.calls[0][1] as Record<string, unknown>;
    expect(fake.openedWith()).toBe("https://idp.example.com/authorize?x=1");
    expect(capturedOptions.displayInIframe).toBe(false);
  });

  it("resolves with the redirect URL the dialog posts back", async () => {
    const fake = fakeOffice();
    const pending = adapterFor(fake).launchOAuthFlow("https://idp.example.com/authorize");

    fake.postMessage(`${REDIRECT_URI}?code=abc&state=n1`);

    await expect(pending).resolves.toBe(`${REDIRECT_URI}?code=abc&state=n1`);
    expect(fake.closeCount()).toBe(1);
  });

  it("rejects a message that is not an absolute URL", async () => {
    // Guards against a legacy callback page that redeems the token itself and
    // posts back a JSON token blob — that shape must not reach login()'s parser.
    const fake = fakeOffice();
    const pending = adapterFor(fake).launchOAuthFlow("https://idp.example.com/authorize");

    fake.postMessage('{"access_token":"leaked"}');

    await expect(pending).rejects.toThrow(/not an absolute redirect URL/);
    expect(fake.closeCount()).toBe(1);
  });

  it("reports a user-cancelled dialog distinctly", async () => {
    const fake = fakeOffice();
    const pending = adapterFor(fake).launchOAuthFlow("https://idp.example.com/authorize");

    fake.postEvent(12006);

    await expect(pending).rejects.toThrow(/cancelled/i);
  });

  it("reports any other dialog error with its code", async () => {
    const fake = fakeOffice();
    const pending = adapterFor(fake).launchOAuthFlow("https://idp.example.com/authorize");

    fake.postEvent(12002);

    await expect(pending).rejects.toThrow(/Office dialog error 12002/);
  });

  it("rejects when the dialog cannot be opened at all", async () => {
    const fake = fakeOffice({ failToOpen: true });

    await expect(
      adapterFor(fake).launchOAuthFlow("https://idp.example.com/authorize"),
    ).rejects.toThrow(/failed to open: blocked/);
  });

  it("names the fragment problem when a hash-routed callback hides the code", async () => {
    // ms-word-addin registers `…/taskpane.html#/callback`, which RFC 6749 §3.1.2
    // forbids. The response then lands in the fragment, `searchParams` is empty,
    // and login() reports "No authorization code in redirect" — true, useless.
    const fake = fakeOffice();
    const pending = adapterFor(fake).launchOAuthFlow("https://idp.example.com/authorize");

    fake.postMessage("https://addin.example.com/taskpane.html#/callback?code=abc&state=n1");

    await expect(pending).rejects.toThrow(/inside the URL fragment/);
    await expect(pending).rejects.toThrow(/RFC 6749/);
  });

  it("settles once and closes once when a message and a close race", async () => {
    // Office delivers these through independent handlers with no mutual
    // exclusion, so a user closing the dialog just as it posts hits both.
    const fake = fakeOffice();
    const pending = adapterFor(fake).launchOAuthFlow("https://idp.example.com/authorize");

    fake.postMessage(`${REDIRECT_URI}?code=abc&state=n1`);
    fake.postEvent(12006);

    await expect(pending).resolves.toContain("code=abc");
    expect(fake.closeCount()).toBe(1);
  });
});

describe("login() through the Office adapter — the verifier never leaves the taskpane", () => {
  it("sends an opaque nonce as state and keeps the verifier out of the dialog", async () => {
    const { exchangeCode } = await import("../auth/tokens.js");
    const exchange = vi.mocked(exchangeCode);

    const fake = fakeOffice();
    const identity = adapterFor(fake);

    const pending = login(identity, {
      clientId: "client-1",
      authorizeEndpoint: "https://idp.example.com/authorize",
      tokenEndpoint: "https://idp.example.com/token",
    });

    await vi.waitFor(() => expect(fake.openedWith()).not.toBe(""));

    const authorizeUrl = new URL(fake.openedWith());
    const state = authorizeUrl.searchParams.get("state") ?? "";

    // 1. S256, never plain.
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");

    // 2. `state` is an opaque nonce. The old encodePKCEState produced base64url
    //    of `{"verifier":"…"}`; if that ever returns, this parses instead of throwing.
    let decoded: unknown = null;
    try {
      decoded = JSON.parse(atob(state.replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      decoded = null;
    }
    expect(decoded).toBeNull();

    fake.postMessage(`${REDIRECT_URI}?code=authcode&state=${state}`);
    await pending;

    // 3. The verifier that the taskpane used for the exchange must appear
    //    NOWHERE in what the dialog was given.
    const verifierUsed = exchange.mock.calls[0][1];
    expect(verifierUsed).toHaveLength(43);
    expect(fake.openedWith()).not.toContain(verifierUsed);
    expect(state).not.toContain(verifierUsed);
  });
});
