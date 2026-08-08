// The Zitadel organization scope, shared by both PKCE entry points.
//
// This started module-private inside `login.ts`, which meant only the
// adapter-driven `login()` could pin an organization. `BrowserRedirectOptions`
// had no `orgId` at all, so a surface that supports both paths had to hand-build
// the URN for the browser half.
//
// `ms-word-addin` shipped exactly that asymmetry (PDEV-7369): the dialog path
// passed `orgId`, the browser fallback did not. Nothing fails when the org scope
// is missing. Zitadel resolves the user's home organization instead, so a
// multi-org developer who fell back to the redirect flow authenticated into
// another tenant and saw its data. There is no error, no warning, and no
// telemetry signal to find it by. Review caught it, no test did.
//
// Keeping the append in ONE function is the point: two copies of a
// tenant-routing rule is a cross-tenant isolation bug waiting for the next
// divergent edit.
//
// Pure and DOM-free on purpose. `login.ts` is imported by Node (bb-slack-integrations)
// and React Native (blocky-mobile), so nothing in this module may reach a browser
// global, at module scope or inside a function.

/**
 * Zitadel's organization scope prefix.
 *
 * Exported so call sites and tests reference the constant instead of re-spelling
 * the literal. A typo in a re-spelled URN is silent: Zitadel treats the scope as
 * unknown and falls back to the home org, which is the failure above.
 */
export const ORG_SCOPE_PREFIX = "urn:zitadel:iam:org:id:";

/**
 * Append the Zitadel org scope, if an org was requested.
 *
 * Additive and idempotent: a caller that already put the scope in `scopes` does
 * not get it twice, and an absent or blank `orgId` leaves the list untouched
 * rather than emitting a malformed `urn:zitadel:iam:org:id:` with no value.
 *
 * Additive is the load-bearing property. Pinning an org by hand means rebuilding
 * the whole `scope` list, and a caller who forgets to re-list `offline_access`
 * gets no refresh token: the session then dies at the first expiry and the user
 * is bounced back to sign-in with no obvious cause.
 */
export function withOrgScope(
  scopes: readonly string[],
  orgId: string | undefined,
): readonly string[] {
  const trimmed = orgId?.trim();
  if (!trimmed) return scopes;
  const orgScope = `${ORG_SCOPE_PREFIX}${trimmed}`;
  return scopes.includes(orgScope) ? scopes : [...scopes, orgScope];
}
