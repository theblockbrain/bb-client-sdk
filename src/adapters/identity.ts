export interface IdentityAdapter {
  /** Returns the redirect URI to use in the OAuth authorize URL. */
  getRedirectUri(): string;

  /**
   * Open the authorize URL in a browser-managed flow.
   * Resolves with the redirect URL that contains ?code=...&state=...
   * Throws on user cancellation or error.
   */
  launchOAuthFlow(authorizeUrl: string): Promise<string>;
}
