import { afterEach, describe, expect, it, vi } from "vitest";
import { login } from "../auth/login.js";
import {
  createOfficeIdentityAdapter,
  isOfficeDialogCancelled,
  type OfficeDialog,
  OfficeDialogError,
  type OfficeDialogEventArgs,
  type OfficeGlobal,
  openOfficeDialog,
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
function fakeOffice(options: { failToOpen?: boolean; closeThrows?: boolean } = {}): FakeOffice {
  const handlers = new Map<string, (args: OfficeDialogEventArgs) => void>();
  let opened = "";
  let closes = 0;

  const dialog: OfficeDialog = {
    addEventHandler: (eventType, handler) => {
      handlers.set(eventType, handler);
    },
    close: () => {
      closes += 1;
      // The host tears the dialog down when the user closes it, so a later
      // close() throws rather than no-opping.
      if (options.closeThrows) throw new Error("dialog already closed");
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

    // Asserted on the DISCRIMINANT, not the message. This test used to match
    // /cancelled/i, which is the same thing the consuming surfaces were doing
    // (`ms-outlook-addin` had both `/cancelled/i.test(msg)` and a
    // `msg === "cancelled"` sentinel) — and every one of them silently stops
    // working when the message is reworded or translated.
    await expect(pending).rejects.toMatchObject({
      name: "OfficeDialogError",
      reason: "cancelled",
      code: 12006,
    });
    expect(isOfficeDialogCancelled(await pending.catch(e => e))).toBe(true);
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

/**
 * The courier is tested directly, not only through the OAuth hop: the reason it
 * was extracted is that `ms-outlook-addin`'s dictation popup had grown the same
 * mechanics with a *different* payload shape, and PowerPoint/Excel would have
 * been third and fourth. A JSON envelope has to work as well as a redirect URL.
 */
describe("openOfficeDialog", () => {
  interface Envelope {
    text: string;
  }

  const parseEnvelope = (message: string): Envelope => {
    const parsed: unknown = JSON.parse(message);
    if (typeof (parsed as Envelope)?.text !== "string") throw new Error("no text in envelope");
    return parsed as Envelope;
  };

  function openEnvelopeDialog(fake: FakeOffice): Promise<Envelope> {
    return openOfficeDialog<Envelope>({
      office: fake.office,
      url: "https://addin.example.com/dictate.html",
      parse: parseEnvelope,
    });
  }

  it("resolves with whatever the caller's parse returns", async () => {
    const fake = fakeOffice();
    const pending = openEnvelopeDialog(fake);

    fake.postMessage('{"text":"hello"}');

    await expect(pending).resolves.toEqual({ text: "hello" });
    expect(fake.closeCount()).toBe(1);
  });

  it("forces displayInIframe false regardless of caller options", async () => {
    // A popup that needs getUserMedia needs a real window for the browser's
    // permission prompt, the same way an IdP needs one for X-Frame-Options.
    const fake = fakeOffice();
    const spy = vi.spyOn(fake.office.context.ui, "displayDialogAsync");

    const pending = openOfficeDialog<string>({
      office: fake.office,
      url: "https://addin.example.com/dictate.html",
      parse: message => message,
      dialog: { height: 40, width: 20 },
    });
    fake.postMessage("ok");
    await pending;

    expect(spy.mock.calls[0][1]).toMatchObject({
      displayInIframe: false,
      height: 40,
      width: 20,
    });
  });

  it("rejects with reason bad-message when parse throws", async () => {
    const fake = fakeOffice();
    const pending = openEnvelopeDialog(fake);

    fake.postMessage("not json at all");

    await expect(pending).rejects.toMatchObject({
      name: "OfficeDialogError",
      reason: "bad-message",
    });
    expect(fake.closeCount()).toBe(1);
  });

  it("preserves an OfficeDialogError thrown by parse rather than rewrapping it", async () => {
    const fake = fakeOffice();
    const pending = openOfficeDialog<string>({
      office: fake.office,
      url: "https://addin.example.com/dictate.html",
      parse: () => {
        throw new OfficeDialogError("callback page redeemed the token itself", "bad-message");
      },
    });

    fake.postMessage("anything");

    await expect(pending).rejects.toThrow(/redeemed the token itself/);
  });

  it("distinguishes a user close from a host error", async () => {
    const cancelled = fakeOffice();
    const pendingCancelled = openEnvelopeDialog(cancelled);
    cancelled.postEvent(12006);
    const cancelError = await pendingCancelled.catch((err: unknown) => err);

    const broken = fakeOffice();
    const pendingBroken = openEnvelopeDialog(broken);
    broken.postEvent(12002);
    const hostError = await pendingBroken.catch((err: unknown) => err);

    expect(isOfficeDialogCancelled(cancelError)).toBe(true);
    expect(isOfficeDialogCancelled(hostError)).toBe(false);
    expect(hostError).toMatchObject({ reason: "host-error", code: 12002 });
  });

  it("rejects with reason open-failed when the host refuses to open it", async () => {
    const fake = fakeOffice({ failToOpen: true });

    await expect(openEnvelopeDialog(fake)).rejects.toMatchObject({
      name: "OfficeDialogError",
      reason: "open-failed",
    });
  });

  it("survives instanceof across the error's own prototype chain", () => {
    // `Object.setPrototypeOf` in the constructor is what keeps this true once a
    // bundler downlevels the class — the same reason BBApiError does it.
    const err = new OfficeDialogError("x", "cancelled", { code: 12006 });
    expect(err).toBeInstanceOf(OfficeDialogError);
    expect(err).toBeInstanceOf(Error);
    expect(isOfficeDialogCancelled(err)).toBe(true);
    expect(isOfficeDialogCancelled(new Error("cancelled"))).toBe(false);
  });

  it("closes exactly once when a message and a close race", async () => {
    const fake = fakeOffice();
    const pending = openEnvelopeDialog(fake);

    fake.postMessage('{"text":"hello"}');
    fake.postEvent(12006);

    await expect(pending).resolves.toEqual({ text: "hello" });
    expect(fake.closeCount()).toBe(1);
  });

  it("still settles when close() throws because the dialog is already gone", async () => {
    const fake = fakeOffice({ closeThrows: true });
    const pending = openEnvelopeDialog(fake);

    fake.postMessage('{"text":"hello"}');

    await expect(pending).resolves.toEqual({ text: "hello" });
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
