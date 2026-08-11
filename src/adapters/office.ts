/**
 * Everything Office-specific the SDK knows, shipped as one opt-in leaf
 * (`@theblockbrain/bb-client-sdk/adapters/office`): the PKCE browser hop, the
 * generic dialog courier behind it, persistence, and the host theme.
 *
 * They live together because they share one constraint, not one feature: each is
 * useless off an Office host and each is expressed *structurally*, so the SDK
 * takes no dependency on `@types/office-js` and non-Office consumers (Slack, Lit,
 * React Native) never pull any of it in. The dialog hop is the founding member
 * and the rest of this header is its story.
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
 * and the core stays runtime-agnostic (invariants A + B). The real `Office`
 * namespace satisfies it directly, as does the test double in `office.test.ts`.
 * Non-Office consumers (Slack, Lit, React Native) never pull this subpath in.
 *
 * "Directly" is load-bearing, and it was not true at first: the token positions
 * were typed `string`, which no real `Office` can satisfy under
 * `@types/office-js`. See {@link OfficeToken} for what that cost the first
 * adopter and why the fix is a union rather than a cast.
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

import type { Theme } from "../ui/theme-mode.js";
import type { IdentityAdapter } from "./identity.js";

// Persistence for an Office add-in ships from this same subpath: a surface that
// needs the dialog hop needs somewhere to keep the resulting session, and both
// are Office-only, so neither belongs in the host-agnostic `./adapters` barrel.
export type {
  OfficeRuntimeStorageArea,
  OfficeStorageAdapter,
  OfficeStorageConfig,
  RoamingSettingsArea,
} from "./office-storage.js";
export { createOfficeStorageAdapter } from "./office-storage.js";

// ─── Structural Office.js surface ─────────────────────────────────────────────

/**
 * An Office.js enum-member token: an `AsyncResult.status`, an `EventType` member,
 * an `AsyncResultStatus` member.
 *
 * **Why a union, and not sloppiness.** The declaration and the runtime disagree
 * about what these are, and the SDK has to accept whichever the host actually
 * hands over. `@types/office-js` declares both enums with no initialisers, which
 * makes every member an *implicit numeric* enum member:
 *
 * ```ts
 * enum AsyncResultStatus { Succeeded, Failed }   // => 0, 1
 * enum EventType { ActiveViewChanged, ... }
 * ```
 *
 * The values the Office runtime actually puts in them are strings (`"failed"`,
 * `"dialogMessageReceived"`). This file used to type these positions `string`, on
 * the strength of having read a live `Office` object, with a comment asserting it
 * was verified. The runtime observation was right and the conclusion was wrong:
 * `typeof Office` still does not satisfy {@link OfficeGlobal} under those
 * typings, because the callback parameter is contravariant and the mismatch
 * surfaces as `Type 'Office.AsyncResultStatus' is not assignable to type
 * 'string'` on `displayDialogAsync`.
 *
 * The first adopter (`ms-word-addin`) paid for that with a ~50-line bridge whose
 * only job was re-presenting the real namespace under this type. All four token
 * positions were individually load-bearing: narrowing any single one back to
 * `string` reproduces the failure, so all four use this alias.
 *
 * **Never coerce a token.** Every value of this type is either compared against
 * another token from the same host or handed straight back to Office
 * (`addEventHandler`). `String(token)` would look tidier and would silently break
 * `addEventHandler` the day a host really does use the numeric representation.
 * Passing the value through untouched is correct under both.
 */
export type OfficeToken = string | number;

/** `Office.AsyncResult` — only `status`, `value` and `error` are read. */
export interface OfficeAsyncResult<T> {
  /**
   * Compared against {@link OfficeGlobal.AsyncResultStatus}, never inspected.
   *
   * An {@link OfficeToken} rather than `string`: the runtime supplies
   * `"succeeded"` / `"failed"`, `@types/office-js` declares
   * `AsyncResultStatus.Succeeded` / `.Failed` as `0` / `1`. Note that a numeric
   * `Succeeded` is `0`, so a truthiness test on this field is always a bug.
   */
  status: OfficeToken;
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
  /** `eventType` is whatever came off {@link OfficeGlobal.EventType}, unchanged. */
  addEventHandler(eventType: OfficeToken, handler: (args: OfficeDialogEventArgs) => void): void;
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
 * so the SDK takes no dependency on Office.js.
 *
 * **Pass the real global `Office`.** That works as written, and no bridge is
 * needed: every enum-member position is an {@link OfficeToken}, which a numeric
 * enum member and a plain string both satisfy. A hand-written double keeps
 * working too, since widening a type only ever accepts more.
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
    /**
     * The host's own appearance. Optional because it genuinely is: see
     * {@link OfficeThemeColors}.
     *
     * Declared here so one `OfficeGlobal` can be handed to both the identity
     * adapter and {@link readOfficeHostTheme} without being re-typed.
     */
    officeTheme?: OfficeThemeColors;
  };
  EventType: {
    DialogMessageReceived: OfficeToken;
    DialogEventReceived: OfficeToken;
  };
  AsyncResultStatus: {
    Failed: OfficeToken;
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
  /**
   * Dialog sizing. Defaults to 60% × 30%.
   *
   * `displayInIframe` is deliberately not settable here. It is part of
   * {@link OfficeDialogOptions} because that interface also types the real
   * `displayDialogAsync` parameter, but for this adapter's one use — an IdP
   * authorize page — `true` is broken in every supported configuration: the IdP
   * sends `X-Frame-Options`/CSP `frame-ancestors` and the dialog renders blank.
   * A same-origin proxied IdP would be the one case where framing could work,
   * and that is not a supported deployment (`authorizeEndpoint` stays pinned to
   * the prod authority — see the audience-pinning invariant). So the option is
   * omitted rather than accepted-and-ignored: a caller who passes it gets a
   * compile error instead of a blank dialog to debug.
   */
  dialog?: Omit<OfficeDialogOptions, "displayInIframe">;
  /**
   * Fires once the sign-in dialog is on screen, before `login()` resolves.
   *
   * Forwarded to {@link OpenOfficeDialogConfig.onOpened}, which explains why a
   * sign-in screen needs this moment and cannot use the settled promise for it.
   */
  onOpened?: () => void;
}

/** Office's code for "the user closed the dialog", worth its own message. */
const DIALOG_CLOSED_BY_USER = 12006;

const DEFAULT_DIALOG: OfficeDialogOptions = {
  height: 60,
  width: 30,
  // Never iframe an IdP — see OfficeDialogOptions.displayInIframe.
  displayInIframe: false,
};

// ─── Generic dialog courier ───────────────────────────────────────────────────

/**
 * Why a dialog did not produce a value.
 *
 * A discriminant, not prose. Every surface that opens an Office dialog has to
 * tell "the user closed it" (normal, show nothing) from "it broke" (show an
 * error), and every one of them was doing it by **matching on message text**:
 * `ms-outlook-addin` had `/cancelled/i.test(msg)` in `Login.tsx` and a separate
 * `msg === "cancelled"` sentinel for dictation. Both silently stop working the
 * moment the message is translated — which is exactly what happens when a
 * surface wires up L12.
 */
export type OfficeDialogFailure =
  /** `displayDialogAsync` never opened the dialog. */
  | "open-failed"
  /** The user closed it (Office code 12006). Normal, not an error. */
  | "cancelled"
  /** Office reported some other dialog error; `code` carries it. */
  | "host-error"
  /** A message arrived but `parse` rejected it. */
  | "bad-message";

/** Thrown by {@link openOfficeDialog}. Carries a typed {@link OfficeDialogFailure}. */
export class OfficeDialogError extends Error {
  readonly reason: OfficeDialogFailure;
  /** Office's numeric error code, when the host supplied one. */
  readonly code?: number;

  constructor(message: string, reason: OfficeDialogFailure, options?: { code?: number }) {
    super(message);
    this.name = "OfficeDialogError";
    this.reason = reason;
    this.code = options?.code;
    // Preserve prototype so `instanceof` survives bundler realms — same reason
    // `BBApiError` does it.
    Object.setPrototypeOf(this, OfficeDialogError.prototype);
  }
}

/** True for an {@link OfficeDialogError} with the given reason. */
export function isOfficeDialogCancelled(err: unknown): boolean {
  return err instanceof OfficeDialogError && err.reason === "cancelled";
}

export interface OpenOfficeDialogConfig<T> {
  /** The Office namespace — pass the global `Office`. */
  office: OfficeGlobal;
  /** Absolute URL to open. */
  url: string;
  /**
   * Turn the `messageParent` payload into the resolved value.
   *
   * Throw to reject with `reason: "bad-message"` — validation belongs to the
   * caller because only it knows what its dialog posts back. The OAuth hop
   * expects a redirect URL; the dictation popup expects a JSON envelope.
   */
  parse: (message: string) => T;
  /** Dialog sizing. Defaults to 60% × 30%. */
  dialog?: Omit<OfficeDialogOptions, "displayInIframe">;
  /**
   * Fires once, when the dialog is actually on screen, before this promise
   * settles. Not called at all if the dialog fails to open.
   *
   * Ported from `ms-word-addin`, which had to reach inside its own Office bridge
   * to get at this moment (PDEV-3804), because the promise was the only thing the
   * SDK exposed. Between the click and `displayDialogAsync` calling back,
   * Microsoft 365 puts up its own "this add-in wants to display a new window"
   * prompt. A surface that raises a full-pane "Signing you in..." overlay on
   * click therefore covers the very button the user still has to press, so the
   * overlay has to wait for this signal rather than for the click.
   *
   * The settled promise cannot serve instead: it resolves when the dialog is
   * finished, which is far too late to hide a progress indicator that was in the
   * way the whole time.
   *
   * A throw from this handler is swallowed. It runs on Office's stack inside the
   * `displayDialogAsync` callback, outside the promise executor, so an escaping
   * error would take down the flow and leave the promise pending forever. Losing
   * a sign-in to a broken progress indicator is not a trade worth making.
   */
  onOpened?: () => void;
}

/**
 * Open an Office dialog and resolve with whatever it posts back.
 *
 * **The dialog is a courier.** It is a separate browsing context that cannot read
 * the taskpane's memory, so the only thing crossing the boundary is one string
 * through `messageParent`. This function owns the mechanics every Office surface
 * was re-implementing: opening it, the settle-once guard, mapping code 12006 to
 * a cancellation, and closing it exactly once.
 *
 * Extracted from {@link createOfficeIdentityAdapter} (which now calls it) because
 * `ms-outlook-addin`'s dictation popup had grown the same ~60 lines
 * independently, and PowerPoint/Excel would have been third and fourth. The OAuth
 * hop is one *use* of an Office dialog, not the definition of one.
 *
 * `displayInIframe` is forced `false`: an IdP sends `X-Frame-Options` and renders
 * blank, and a popup that needs `getUserMedia` needs a real window for the
 * browser's permission prompt. No caller has wanted `true`.
 */
export function openOfficeDialog<T>(config: OpenOfficeDialogConfig<T>): Promise<T> {
  const { office, url, parse, onOpened } = config;
  const dialogOptions: OfficeDialogOptions = {
    ...DEFAULT_DIALOG,
    ...config.dialog,
    displayInIframe: false,
  };

  return new Promise<T>((resolve, reject) => {
    office.context.ui.displayDialogAsync(url, dialogOptions, result => {
      if (result.status === office.AsyncResultStatus.Failed) {
        reject(
          new OfficeDialogError(
            `Office dialog failed to open: ${result.error?.message ?? "unknown error"}`,
            "open-failed",
            { code: result.error?.code },
          ),
        );
        return;
      }

      const dialog = result.value;
      // Office delivers the message and the close event through separate handlers
      // with no mutual exclusion, so a user closing the dialog just after it posts
      // would settle the promise twice. Promises ignore the second settle, but the
      // dialog would be closed twice — guard both.
      let settled = false;

      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        try {
          dialog.close();
        } catch {
          // Already gone (user closed it, host tore it down). Not an error: the
          // outcome we care about has already been decided.
        }
        action();
      };

      dialog.addEventHandler(office.EventType.DialogMessageReceived, args => {
        let value: T;
        try {
          value = parse(args.message ?? "");
        } catch (err) {
          finish(() =>
            reject(
              err instanceof OfficeDialogError
                ? err
                : new OfficeDialogError(
                    err instanceof Error ? err.message : "Unusable message from Office dialog.",
                    "bad-message",
                  ),
            ),
          );
          return;
        }
        finish(() => resolve(value));
      });

      dialog.addEventHandler(office.EventType.DialogEventReceived, args => {
        finish(() =>
          reject(
            args.error === DIALOG_CLOSED_BY_USER
              ? new OfficeDialogError("The dialog was closed.", "cancelled", {
                  code: args.error,
                })
              : new OfficeDialogError(
                  `Office dialog error${args.error === undefined ? "" : ` ${args.error}`}.`,
                  "host-error",
                  { code: args.error },
                ),
          ),
        );
      });

      // Announced last, once both handlers are wired. The caller is told the
      // dialog is on screen only when this side can actually receive from it, so
      // a slow or throwing handler cannot delay or reorder Office's delivery.
      // Still strictly before the promise settles: settling needs one of the
      // handlers above, which cannot run until this callback returns.
      try {
        onOpened?.();
      } catch {
        // See OpenOfficeDialogConfig.onOpened: this runs on Office's stack,
        // outside the promise executor, so an escaping error would strand the
        // promise pending forever. A caller's progress indicator does not get to
        // break sign-in.
      }
    });
  });
}

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

  return {
    getRedirectUri: () => redirectUri,

    launchOAuthFlow: (authorizeUrl: string): Promise<string> =>
      openOfficeDialog<string>({
        office,
        url: authorizeUrl,
        dialog: config.dialog,
        onOpened: config.onOpened,
        // The dialog is a courier: it posts back the redirect URL and nothing
        // else. Validating here means `login()` never has to defend against a
        // message from some other sender on the same channel.
        parse: message => {
          if (!isAbsoluteUrl(message)) {
            throw new OfficeDialogError(
              "Office dialog posted a message that is not an absolute redirect URL. " +
                "The callback page must call " +
                "`Office.context.ui.messageParent(window.location.href)` and must NOT " +
                "redeem the token itself — the verifier stays in the taskpane.",
              "bad-message",
            );
          }

          const fragmentProblem = describeFragmentRoutedCallback(message);
          if (fragmentProblem) throw new OfficeDialogError(fragmentProblem, "bad-message");

          return message;
        },
      }),
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

// ─── Host theme ───────────────────────────────────────────────────────────────

/**
 * The slice of `Office.context.officeTheme` this module reads.
 *
 * **Both fields are optional, and `@types/office-js` declares both as required.**
 * That is not sloppiness, it is the same declaration-versus-runtime gap
 * {@link OfficeToken} documents, and it is the whole reason
 * {@link readOfficeHostTheme} has two paths:
 *
 * - `isDarkTheme` is typed `boolean`, and the typings themselves say it "isn't
 *   supported in Outlook". In Outlook it is `undefined` at runtime while the
 *   compiler insists it is a boolean.
 * - `officeTheme` itself is typed non-optional, but in Outlook it only exists
 *   from Mailbox requirement set 1.14, and it is absent in the dialog window.
 *
 * So a surface cannot trust either field's declared type, and two Office add-ins
 * independently reached opposite conclusions about which one to read: Word took
 * the flag, Outlook computed luminance from the colours and asserted in a comment
 * that "Office reports colours, not a light/dark flag". Both were right about
 * their own host and wrong as a general rule.
 */
export interface OfficeThemeColors {
  /**
   * `true` when the host is on a dark theme. Word, Excel and PowerPoint report
   * this. **Outlook does not** — it is `undefined` there.
   */
  isDarkTheme?: boolean;
  /**
   * Body background as a hex triplet, e.g. `"#FFA500"`. Reported by every host
   * that reports a theme at all, and the only signal Outlook gives.
   */
  bodyBackgroundColor?: string;
}

/**
 * Any object shaped like the `Office` namespace as far as the theme is
 * concerned. {@link OfficeGlobal} satisfies it, and so does the real `Office`.
 */
export interface OfficeThemeHost {
  context: { officeTheme?: OfficeThemeColors };
}

/**
 * Perceived brightness of a `#rrggbb` colour, 0 (black) to 1 (white).
 *
 * ITU-R BT.601 coefficients rather than a plain average, because green
 * contributes far more perceived brightness than blue and averaging
 * misclassifies saturated backgrounds.
 *
 * Anything that is not a six-digit hex triplet returns `null` and is treated as
 * "no opinion" by the caller. Guessing at some other notation would be inventing
 * a host contract that has never been observed.
 */
function luminance(hex: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Below this, the background is dark. Midpoint, and it has never needed tuning. */
const DARK_BACKGROUND_BELOW = 0.5;

/**
 * The Office host's own theme, or `null` when it will not say.
 *
 * **One function, two mechanisms, because the hosts genuinely differ.** The flag
 * is tried first and the luminance of `bodyBackgroundColor` is the fallback:
 *
 * | Host | What answers |
 * |---|---|
 * | Word, Excel, PowerPoint | `isDarkTheme` |
 * | Outlook (Mailbox 1.14+) | `bodyBackgroundColor` luminance |
 * | Outlook (older), any dialog window | neither — `null` |
 *
 * Order matters: where the flag exists it is the host's own answer, and
 * luminance is an inference from one colour. Where the flag is missing the
 * inference is all there is. Neither add-in could have skipped the other's path
 * without breaking on the other's host.
 *
 * **`null` is a real answer, not a failure.** It means "no opinion", and the
 * caller must leave `data-host-theme` off the root rather than defaulting to
 * light — that absence is what hands resolution back to
 * `@media (prefers-color-scheme: dark)`. See `useTheme`'s `hostTheme` option,
 * which takes this value directly and does exactly that.
 *
 * **Detection is adapter-side by design.** The SDK never touches the `Office`
 * identifier itself (it takes no dependency on `@types/office-js`), so a surface
 * passes the namespace in. Outside Office the identifier is not merely undefined
 * but undeclared, and `Office?.context` still throws on it, so the caller's guard
 * is `typeof Office === "undefined" ? null : Office` and this function accepts
 * the nullish result rather than making every call site branch twice.
 */
export function readOfficeHostTheme(host: OfficeThemeHost | null | undefined): Theme | null {
  try {
    const theme = host?.context?.officeTheme;
    if (!theme) return null;

    if (typeof theme.isDarkTheme === "boolean") return theme.isDarkTheme ? "dark" : "light";

    const background = theme.bodyBackgroundColor;
    if (!background) return null;
    const value = luminance(background);
    if (value === null) return null;
    return value < DARK_BACKGROUND_BELOW ? "dark" : "light";
  } catch {
    // Office is present but not initialised yet. Deliberately silent: this runs
    // on a poll, so a log line here would repeat forever for a non-condition.
    return null;
  }
}

/**
 * How often {@link watchOfficeHostTheme} asks. Slow enough to be free, fast
 * enough that flipping the host theme feels immediate.
 */
export const OFFICE_HOST_THEME_POLL_MS = 2000;

export interface WatchOfficeHostThemeConfig {
  /** The Office namespace, or `null` outside Office. */
  host: OfficeThemeHost | null | undefined;
  /** Fires on the first known theme and on every change after it. */
  onChange: (theme: Theme) => void;
  /** Poll period. Defaults to {@link OFFICE_HOST_THEME_POLL_MS}. */
  intervalMs?: number;
}

/**
 * Follow the host theme for as long as the surface is open. Returns the stop
 * function.
 *
 * **Why a poll and not an event.** Office raises `OfficeThemeChanged` only under
 * Outlook's Mailbox 1.14, through `mailbox.addHandlerAsync` — and Word, Excel and
 * PowerPoint have no `Office.context.mailbox` at all, so there is nothing to
 * subscribe to there. Polling is the only mechanism that works on every host,
 * which is why it belongs here rather than in one add-in: Word wrote this loop,
 * and Outlook, which applied the theme once inside `Office.onReady`, silently
 * ignored the user changing it afterwards.
 *
 * `onChange` fires only on a real change. The read is cheap but the consumer's
 * reaction is not: writing an attribute invalidates style for the whole subtree
 * even when the value is unchanged, and a poll that never stops would do that
 * forever.
 *
 * A read that comes back `null` is skipped rather than reported. Office answers
 * only after `Office.onReady`, and a momentary "no opinion" must not wipe out a
 * theme already known — the surface would flash back to the OS theme and then
 * correct itself.
 */
export function watchOfficeHostTheme(config: WatchOfficeHostThemeConfig): () => void {
  const { host, onChange } = config;
  let current: Theme | null = null;

  const sync = (): void => {
    const next = readOfficeHostTheme(host);
    if (next === null || next === current) return;
    current = next;
    onChange(next);
  };

  sync();
  const timer = setInterval(sync, config.intervalMs ?? OFFICE_HOST_THEME_POLL_MS);
  return () => clearInterval(timer);
}
