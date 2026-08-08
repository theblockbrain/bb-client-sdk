import { afterEach, describe, expect, it, vi } from "vitest";
import { login } from "../auth/login.js";
import {
  createOfficeIdentityAdapter,
  isOfficeDialogCancelled,
  type OfficeDialog,
  OfficeDialogError,
  type OfficeDialogEventArgs,
  type OfficeGlobal,
  type OfficeToken,
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

/** The four enum-member tokens a host has to supply, in one representation. */
interface TokenSet {
  messageReceived: OfficeToken;
  eventReceived: OfficeToken;
  succeeded: OfficeToken;
  failed: OfficeToken;
}

/** What the Office RUNTIME actually puts in those enums. */
const STRING_TOKENS = {
  messageReceived: "dialogMessageReceived",
  eventReceived: "dialogEventReceived",
  succeeded: "succeeded",
  failed: "failed",
} as const;

/**
 * What `@types/office-js` DECLARES, reproduced faithfully rather than imported.
 *
 * Both enums are declared with no initialisers, so every member is an implicit
 * numeric one. The leading `EventType` members are kept so the dialog tokens land
 * on realistic indices (3 and 4) instead of colliding with the status values.
 *
 * The SDK must not import Office.js (invariant A), so this is how the declared
 * shape gets into a test at all.
 */
enum DeclaredAsyncResultStatus {
  Succeeded,
  Failed,
}
enum DeclaredEventType {
  ActiveViewChanged,
  AppointmentTimeChanged,
  AttachmentsChanged,
  DialogEventReceived,
  DialogMessageReceived,
}

const NUMERIC_TOKENS = {
  messageReceived: DeclaredEventType.DialogMessageReceived,
  eventReceived: DeclaredEventType.DialogEventReceived,
  // 0. Falsy, which is the whole reason a truthiness test on `status` is a bug.
  succeeded: DeclaredAsyncResultStatus.Succeeded,
  failed: DeclaredAsyncResultStatus.Failed,
} as const;

interface FakeOffice {
  office: OfficeGlobal;
  /** The URL the dialog was opened with. */
  openedWith: () => string;
  /** Simulate the callback page calling `messageParent`. */
  postMessage: (message: string) => void;
  /** Simulate a dialog-level event (e.g. the user closing it). */
  postEvent: (error: number) => void;
  closeCount: () => number;
  /** Every `eventType` the adapter handed to `addEventHandler`, in order. */
  eventTypesSeen: () => OfficeToken[];
}

/** A test double for the slice of Office.js the adapter uses. */
function fakeOffice(
  options: { failToOpen?: boolean; closeThrows?: boolean; tokens?: TokenSet } = {},
): FakeOffice {
  // String by default: that is what a live host supplies, so the rest of the file
  // keeps exercising the representation real add-ins see.
  const tokens = options.tokens ?? STRING_TOKENS;
  const handlers = new Map<OfficeToken, (args: OfficeDialogEventArgs) => void>();
  const eventTypes: OfficeToken[] = [];
  let opened = "";
  let closes = 0;

  const dialog: OfficeDialog = {
    addEventHandler: (eventType, handler) => {
      eventTypes.push(eventType);
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
            callback({ status: tokens.failed, value: dialog, error: { message: "blocked" } });
            return;
          }
          callback({ status: tokens.succeeded, value: dialog });
        },
      },
    },
    EventType: {
      DialogMessageReceived: tokens.messageReceived,
      DialogEventReceived: tokens.eventReceived,
    },
    AsyncResultStatus: { Failed: tokens.failed },
  };

  return {
    office,
    openedWith: () => opened,
    postMessage: message => handlers.get(tokens.messageReceived)?.({ message }),
    postEvent: error => handlers.get(tokens.eventReceived)?.({ error }),
    closeCount: () => closes,
    eventTypesSeen: () => eventTypes,
  };
}

// Outlook's real shape: fragment-free, as RFC 6749 §3.1.2 requires.
const REDIRECT_URI = "https://addin.example.com/taskpane.html";

function adapterFor(fake: FakeOffice, onOpened?: () => void) {
  return createOfficeIdentityAdapter({ office: fake.office, redirectUri: REDIRECT_URI, onOpened });
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
 * PDEV-7369. `OfficeGlobal` typed its four enum-member positions `string`, which
 * no real `Office` namespace can satisfy: `@types/office-js` declares `EventType`
 * and `AsyncResultStatus` with no initialisers, so their members are numeric, and
 * because the `displayDialogAsync` callback parameter is contravariant the mismatch
 * lands as `Type 'Office.AsyncResultStatus' is not assignable to type 'string'`.
 * The first adopter (`ms-word-addin`) paid for that with a ~50-line bridge whose
 * only job was re-presenting the real namespace under this type.
 *
 * `OfficeToken` is `string | number` so the namespace goes straight in. This block
 * pins both halves of that: the compile-time assignment, and the behaviour that
 * makes the union safe rather than merely permissive.
 */
describe("OfficeGlobal token representations", () => {
  const cases: Array<[string, TokenSet]> = [
    ["string tokens, as the Office runtime supplies them", STRING_TOKENS],
    ["numeric enum members, as @types/office-js declares them", NUMERIC_TOKENS],
  ];

  it("takes a whole namespace by assignment, with no bridge", () => {
    // The real assertion here is that this file TYPECHECKS. `declaredOffice`
    // reproduces the @types/office-js shape: numeric enum objects, and a callback
    // parameter typed with them, which is where the contravariance bites. Narrow
    // any one token position back to `string` and this annotation stops compiling,
    // so `tsc --noEmit` is where the regression surfaces, not vitest.
    //
    // All four positions were checked individually against the real typings: each
    // one alone reproduces the failure, which is why all four use OfficeToken.
    // Members copied from @types/office-js rather than approximated, so the only
    // friction left to test is the token types. `Office.AsyncResult` really does
    // declare `error` as required, and `Office.Dialog.addEventHandler` really does
    // take that two-member union rather than a single args type.
    interface DeclaredAsyncResult<T> {
      status: DeclaredAsyncResultStatus;
      value: T;
      error: { code: number; message: string; name: string };
    }
    interface DeclaredDialog {
      addEventHandler(
        eventType: DeclaredEventType,
        handler: (
          args: { message: string; origin: string | undefined } | { error: number },
        ) => void,
      ): void;
      close(): void;
    }
    interface DeclaredOfficeNamespace {
      context: {
        ui: {
          displayDialogAsync(
            startAddress: string,
            options?: { height?: number; width?: number; displayInIframe?: boolean },
            callback?: (result: DeclaredAsyncResult<DeclaredDialog>) => void,
          ): void;
        };
      };
      EventType: typeof DeclaredEventType;
      AsyncResultStatus: typeof DeclaredAsyncResultStatus;
    }

    const declaredOffice: DeclaredOfficeNamespace = {
      context: { ui: { displayDialogAsync: () => {} } },
      EventType: DeclaredEventType,
      AsyncResultStatus: DeclaredAsyncResultStatus,
    };

    const asOfficeGlobal: OfficeGlobal = declaredOffice;

    expect(asOfficeGlobal).toBe(declaredOffice);
  });

  it.each(cases)("completes the dialog round trip with %s", async (_label, tokens) => {
    const fake = fakeOffice({ tokens });
    const pending = adapterFor(fake).launchOAuthFlow("https://idp.example.com/authorize");

    fake.postMessage(`${REDIRECT_URI}?code=abc&state=n1`);

    await expect(pending).resolves.toContain("code=abc");
    expect(fake.closeCount()).toBe(1);
  });

  it.each(cases)("detects a refused open with %s", async (_label, tokens) => {
    // The numeric case is the sharp one: Succeeded is 0 and Failed is 1, so a
    // truthiness test on `status` would invert the outcome rather than fail
    // loudly. Only an === against the host's own Failed token is safe.
    const fake = fakeOffice({ tokens, failToOpen: true });

    await expect(
      adapterFor(fake).launchOAuthFlow("https://idp.example.com/authorize"),
    ).rejects.toMatchObject({ reason: "open-failed" });
  });

  it.each(cases)("hands %s back to addEventHandler untransformed", async (_label, tokens) => {
    // The property the word-addin bridge went out of its way to preserve. A token
    // is only ever compared against another token from the same host or handed
    // straight back to Office, so `String(token)` would look tidier and would
    // silently break registration on a numeric host. toStrictEqual on the raw
    // values catches a coercion that a loose compare would let through.
    const fake = fakeOffice({ tokens });
    const pending = adapterFor(fake).launchOAuthFlow("https://idp.example.com/authorize");
    fake.postMessage(`${REDIRECT_URI}?code=abc&state=n1`);
    await pending;

    expect(fake.eventTypesSeen()).toStrictEqual([tokens.messageReceived, tokens.eventReceived]);
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

/**
 * PDEV-3804, ported from `ms-word-addin`. Between the click and the dialog
 * appearing, Microsoft 365 shows its own "this add-in wants to display a new
 * window" prompt. A surface that raises a full-pane "Signing you in..." overlay on
 * click covers the very button the user has to press, so the overlay needs the
 * moment the dialog is really on screen. `openOfficeDialog` exposed only the
 * settled promise, which resolves when the dialog is FINISHED, so the add-in had
 * to reach inside its own Office bridge to get at this.
 */
describe("onOpened", () => {
  const openWith = (fake: FakeOffice, onOpened?: () => void): Promise<string> =>
    openOfficeDialog<string>({
      office: fake.office,
      url: "https://addin.example.com/dictate.html",
      parse: message => message,
      onOpened,
    });

  it("fires once, before the promise settles", async () => {
    const fake = fakeOffice();
    const order: string[] = [];

    const pending = openWith(fake, () => order.push("opened"));

    // Already fired, synchronously inside the displayDialogAsync callback and
    // before any message could arrive. That ordering is the entire point: an
    // overlay hidden only on settle was in the way for the whole sign-in.
    expect(order).toEqual(["opened"]);

    fake.postMessage("ok");
    await pending;
    order.push("settled");

    expect(order).toEqual(["opened", "settled"]);
  });

  it("does not fire when the dialog fails to open", async () => {
    // Nothing is on screen, so a surface that hid its own button on this signal
    // would strand the user looking at a blank pane.
    const fake = fakeOffice({ failToOpen: true });
    const onOpened = vi.fn();

    await expect(openWith(fake, onOpened)).rejects.toMatchObject({ reason: "open-failed" });

    expect(onOpened).not.toHaveBeenCalled();
  });

  it("survives a handler that throws, without breaking sign-in", async () => {
    // It runs on Office's stack inside the displayDialogAsync callback, OUTSIDE
    // the promise executor, so an escaping error would strand the promise pending
    // forever. A caller's broken progress indicator does not get to cost a login.
    const fake = fakeOffice();

    const pending = openWith(fake, () => {
      throw new Error("setState on an unmounted overlay");
    });
    fake.postMessage("ok");

    await expect(pending).resolves.toBe("ok");
    expect(fake.closeCount()).toBe(1);
  });

  it("is optional, so existing callers are unaffected", async () => {
    // Additive by construction: the key is absent, not undefined. Five live
    // consumers call these two functions without it.
    const fake = fakeOffice();
    const identity = createOfficeIdentityAdapter({
      office: fake.office,
      redirectUri: REDIRECT_URI,
    });

    const pending = identity.launchOAuthFlow("https://idp.example.com/authorize");
    fake.postMessage(`${REDIRECT_URI}?code=abc&state=n1`);

    await expect(pending).resolves.toContain("code=abc");
  });

  it("is forwarded by createOfficeIdentityAdapter to the underlying dialog", async () => {
    // The gap the add-in actually hit: it needed this on the OAuth hop, and the
    // hop is built by the factory, so a signal only on openOfficeDialog would not
    // have reached it.
    const fake = fakeOffice();
    const onOpened = vi.fn();

    const pending = adapterFor(fake, onOpened).launchOAuthFlow("https://idp.example.com/authorize");
    expect(onOpened).toHaveBeenCalledTimes(1);

    fake.postMessage(`${REDIRECT_URI}?code=abc&state=n1`);
    await pending;

    expect(onOpened).toHaveBeenCalledTimes(1);
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
