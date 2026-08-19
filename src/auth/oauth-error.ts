/**
 * An OAuth authorization-response error, carried as a type rather than as prose.
 *
 * Both sign-in flows can end with the provider redirecting back an `error` param
 * instead of a `code`: the dialog flow ({@link login}) and the full-page redirect
 * flow ({@link completeBrowserLogin}). Both used to throw a plain `Error` whose
 * message was the only record of which error it was, which left every consumer two
 * bad options: match on the message text, or show the SDK's English sentence to
 * the user.
 *
 * Neither is acceptable at this layer. The message is not a contract, so matching
 * it breaks the first time the wording changes or a surface translates it, and the
 * sentence is not product copy, so putting it in a label ships untranslated
 * developer text. The `code` is the contract. It goes in a field.
 *
 * This mirrors `OfficeDialogError` + `isOfficeDialogCancelled` in the Office
 * adapter, which covers the other way a sign-in ends without a token (the user
 * closing the dialog). A consumer now classifies both the same way.
 */

/** An `error` the provider returned on the redirect, with its own code intact. */
export class OAuthError extends Error {
  /** The `error` param verbatim, e.g. `access_denied`, `unauthorized_client`. */
  readonly code: string;
  /**
   * The `error_description` param, when the provider sent one.
   *
   * Server-authored and untranslated, and it can echo the request back, so it
   * belongs in a log rather than in a label. Kept because it is often the only
   * place the real cause is spelled out.
   */
  readonly description: string | null;

  constructor(code: string, description?: string | null) {
    super(description ? `OAuth ${code}: ${description}` : `OAuth ${code}`);
    this.name = "OAuthError";
    this.code = code;
    this.description = description || null;
    // Preserve prototype so `instanceof` survives bundler realms — same reason
    // `BBApiError` and `OfficeDialogError` do it.
    Object.setPrototypeOf(this, OAuthError.prototype);
  }
}

/**
 * True when authorization was refused rather than failing.
 *
 * `access_denied` is the one code with a user-facing meaning: the user declined
 * the consent screen, or the provider declined on their behalf because the account
 * has no grant for this app. One code covers both, so a consumer's copy has to
 * serve both, but neither is a bug to report and neither should read as a crash.
 *
 * Every other code is operator-facing (`unauthorized_client`, `invalid_scope`,
 * `server_error`, …), so a consumer should surface {@link OAuthError.code} for
 * support rather than trying to word each one.
 */
export function isOAuthDenied(err: unknown): boolean {
  return err instanceof OAuthError && err.code === "access_denied";
}

/**
 * Read the error out of an authorization response, or `null` when there is none.
 *
 * Takes the params rather than a URL so both flows can use it: one has a redirect
 * URL posted back from a dialog, the other has `window.location.search`.
 */
export function readOAuthError(params: URLSearchParams): OAuthError | null {
  const code = params.get("error");
  if (!code) return null;
  return new OAuthError(code, params.get("error_description"));
}
