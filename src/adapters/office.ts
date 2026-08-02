/**
 * Office dialog {@link IdentityAdapter} — the PKCE browser hop for Office add-ins,
 * shipped as an opt-in leaf (`@theblockbrain/bb-client-sdk/adapters/office`).
 *
 * Why this exists (PDEV-7684). An Office add-in cannot do a full-page redirect,
 * so it opens the IdP in `Office.context.ui.displayDialogAsync` — a **separate
 * browsing context** that cannot read the taskpane's memory, and cannot rely on
 * sharing its `sessionStorage`. Getting the PKCE verifier across that boundary
 * is the whole problem, and both add-ins that solved it independently solved it
 * the same wrong way: by base64-ing the verifier into the OAuth `state`
 * parameter.
 *
 * That puts the verifier in the authorize URL, and therefore in browser history,
 * the Referer header, and the IdP's access logs (CWE-200) — which makes an
 * intercepted authorization code redeemable and defeats the one thing PKCE is
 * for. `ms-outlook-addin` did it via the SDK's own (now deleted)
 * `encodePKCEState`; `ms-word-addin` reinvented it from scratch. PowerPoint and
 * Excel are greenfield and would have been third and fourth.
 *
 * The fix is not a different encoding — it is not sending the verifier at all.
 * `login()` keeps the verifier in the taskpane's local scope and sends an
 * opaque nonce as `state`; this adapter makes the dialog a **courier** that
 * carries back only the redirect URL. An intercepted `code` is then useless.
 *
 * Zero new SDK dependency: {@link OfficeGlobal} is a STRUCTURAL type over the
 * handful of Office.js members used, so the SDK never imports `@types/office-js`
 * and the core stays runtime-agnostic (invariants A + B). A real `Office`
 * namespace satisfies it; so does the test double in `office.test.ts`. Non-Office
 * consumers (Slack, Lit, React Native) never pull this subpath in.
 *
 * @example Taskpane
 * ```ts
 * import { login } from "@theblockbrain/bb-client-sdk/auth";
 * import { createOfficeIdentityAdapter } from "@theblockbrain/bb-client-sdk/adapters/office";
 *
 * const identity = createOfficeIdentityAdapter({
 *   office: Office,
 *   // Fragment-free — RFC 6749 §3.1.2 forbids a '#' in a redirect URI, and a
 *   // hash route hides the ?code= inside the fragment where the parser cannot
 *   // see it. Route to your callback view after the taskpane loads instead.
 *   redirectUri: `${window.location.origin}/taskpane.html`,
 * });
 *
 * const result = await login(identity, { clientId: AUTH_CLIENT_ID });
 * ```
 *
 * @example Callback page (runs INSIDE the dialog)
 * ```ts
 * // Do NOT redeem the token here — the dialog has no verifier, by design.
 * // Hand the whole redirect URL back and let the taskpane finish the exchange.
 * Office.context.ui.messageParent(window.location.href);
 * ```
 */

import type { IdentityAdapter } from "./identity.js";

// ─── Structural Office.js surface ─────────────────────────────────────────────

/** `Office.AsyncResult` — only `status`, `value` and `error` are read. */
export interface OfficeAsyncResult<T> {
  /**
   * Compared against {@link OfficeGlobal.AsyncResultStatus}.
   *
   * A **string** enum in Office.js (`"succeeded"` / `"failed"`), not numeric —
   * verified against a real `Office` object, having first assumed otherwise.
   * Typing it `number` made the whole namespace fail to satisfy `OfficeGlobal`,
   * which is the kind of thing only compiling against the real thing catches.
   */
  status: string;
  value: T;
  error?: { code?: number; message?: string };
}

/**
 * Argument of a dialog event handler.
 *
 * `DialogMessageReceived` carries `message`; `DialogEventReceived` carries
 * `error` (e.g. 12006 — the user closed the dialog). One shape covers both
 * because Office delivers them through the same handler signature.
 */
export interface OfficeDialogEventArgs {
  message?: string;
  origin?: string;
  error?: number;
}

/** `Office.Dialog` — only the two members used. */
export interface OfficeDialog {
  addEventHandler(eventType: string, handler: (args: OfficeDialogEventArgs) => void): void;
  close(): void;
}

/** Options forwarded verbatim to `displayDialogAsync`. */
export interface OfficeDialogOptions {
  /** Percentage of screen height. Office clamps this. Default 60. */
  height?: number;
  /** Percentage of screen width. Default 30. */
  width?: number;
  /**
   * Must stay `false` for an IdP hop: identity providers send
   * `X-Frame-Options`/CSP `frame-ancestors`, so an iframed dialog renders blank.
   */
  displayInIframe?: boolean;
  promptBeforeOpen?: boolean;
}

/**
 * The slice of the `Office` namespace this adapter touches, typed structurally
 * so the SDK takes no dependency on Office.js. Pass the real global `Office`.
 */
export interface OfficeGlobal {
  context: {
    ui: {
      displayDialogAsync(
        startAddress: string,
        options: OfficeDialogOptions,
        callback: (result: OfficeAsyncResult<OfficeDialog>) => void,
      ): void;
    };
  };
  EventType: {
    DialogMessageReceived: string;
    DialogEventReceived: string;
  };
  AsyncResultStatus: {
    Failed: string;
  };
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface OfficeIdentityAdapterConfig {
  /** The Office namespace — pass the global `Office`. */
  office: OfficeGlobal;
  /**
   * Redirect URI registered for THIS add-in in Zitadel. Each surface has its own
   * host, so this stays caller-supplied rather than being derived here.
   */
  redirectUri: string;
  /** Dialog sizing. Defaults to 60% × 30%, never iframed. */
  dialog?: OfficeDialogOptions;
}

/** Office's code for "the user closed the dialog", worth its own message. */
const DIALOG_CLOSED_BY_USER = 12006;

const DEFAULT_DIALOG: OfficeDialogOptions = {
  height: 60,
  width: 30,
  // Never iframe an IdP — see OfficeDialogOptions.displayInIframe.
  displayInIframe: false,
};

/**
 * Build an {@link IdentityAdapter} that performs the OAuth hop in an Office dialog.
 *
 * `launchOAuthFlow` resolves with the redirect URL the dialog posted back via
 * `Office.context.ui.messageParent(window.location.href)`, which is exactly what
 * `login()` expects. It rejects if the dialog fails to open, if the user closes
 * it, or if the message is not a parseable URL.
 *
 * The verifier is never passed to, or returned from, the dialog.
 */
export function createOfficeIdentityAdapter(config: OfficeIdentityAdapterConfig): IdentityAdapter {
  const { office, redirectUri } = config;
  const dialogOptions = { ...DEFAULT_DIALOG, ...config.dialog };

  return {
    getRedirectUri: () => redirectUri,

    launchOAuthFlow(authorizeUrl: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        office.context.ui.displayDialogAsync(authorizeUrl, dialogOptions, result => {
          if (result.status === office.AsyncResultStatus.Failed) {
            reject(
              new Error(
                `Office dialog failed to open: ${result.error?.message ?? "unknown error"}`,
              ),
            );
            return;
          }

          const dialog = result.value;
          // Office delivers the message and the close event through separate
          // handlers with no mutual exclusion, so a user closing the dialog just
          // after it posts would settle the promise twice. Promises ignore the
          // second settle, but the dialog would be closed twice — guard both.
          let settled = false;

          const finish = (action: () => void): void => {
            if (settled) return;
            settled = true;
            try {
              dialog.close();
            } catch {
              // Already gone (user closed it, host tore it down). Not an error:
              // the outcome we care about has already been decided.
            }
            action();
          };

          dialog.addEventHandler(office.EventType.DialogMessageReceived, args => {
            const message = args.message ?? "";
            // The dialog is a courier: it posts back the redirect URL and nothing
            // else. Validating here means `login()` never has to defend against a
            // message from some other sender on the same channel.
            if (!isAbsoluteUrl(message)) {
              finish(() =>
                reject(
                  new Error(
                    "Office dialog posted a message that is not an absolute redirect URL. " +
                      "The callback page must call " +
                      "`Office.context.ui.messageParent(window.location.href)` and must NOT " +
                      "redeem the token itself — the verifier stays in the taskpane.",
                  ),
                ),
              );
              return;
            }

            const fragmentProblem = describeFragmentRoutedCallback(message);
            if (fragmentProblem) {
              finish(() => reject(new Error(fragmentProblem)));
              return;
            }

            finish(() => resolve(message));
          });

          dialog.addEventHandler(office.EventType.DialogEventReceived, args => {
            finish(() =>
              reject(
                new Error(
                  args.error === DIALOG_CLOSED_BY_USER
                    ? "Sign-in was cancelled — the dialog was closed."
                    : `Office dialog error${args.error === undefined ? "" : ` ${args.error}`}.`,
                ),
              ),
            );
          });
        });
      });
    },
  };
}

/**
 * True for a parseable absolute URL.
 *
 * `URL` is used rather than a prefix check so a relative path, a bare token, or
 * a JSON blob from a legacy callback page is rejected rather than reaching
 * `login()`'s parser as something that only looks URL-shaped.
 */
function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Catch a hash-routed callback whose `code` landed in the fragment.
 *
 * RFC 6749 §3.1.2: a redirection endpoint URI **MUST NOT include a fragment**.
 * `ms-outlook-addin` complies (`…/taskpane.html`); `ms-word-addin` does not
 * (`…/taskpane.html#/callback`). With a fragment in play the authorization
 * response can end up as `…/taskpane.html#/callback?code=…`, where the query
 * belongs to the fragment — so `new URL(u).searchParams` is empty and `login()`
 * fails with the unhelpful "No authorization code in redirect."
 *
 * Diagnosing that from the taskpane costs an afternoon. The adapter has the URL
 * in hand, so it says what is actually wrong. Returns `null` when fine.
 */
function describeFragmentRoutedCallback(redirectUrl: string): string | null {
  const url = new URL(redirectUrl);
  const hasQueryResponse = url.searchParams.has("code") || url.searchParams.has("error");
  if (hasQueryResponse) return null;

  const fragment = url.hash;
  if (!/[?&](code|error)=/.test(fragment)) return null;

  return (
    "The OAuth response arrived inside the URL fragment, so it is invisible to " +
    "the query parser. This add-in's registered redirect URI almost certainly " +
    "contains a '#' route (e.g. '…/taskpane.html#/callback'), which RFC 6749 " +
    "§3.1.2 forbids. Register a fragment-free redirect URI in Zitadel — route " +
    "to the callback view after the taskpane loads instead."
  );
}
