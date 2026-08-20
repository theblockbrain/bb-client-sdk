/**
 * The email-first sign-in: one address in, a tenant-scoped session out.
 *
 * This is the diagram Tim shared on 2026-07-28, minus the parts we do not build.
 * The user types an e-mail and nothing else. The tenant behind it is resolved in
 * the background. When the answer is ambiguous the surface renders a picker. Then
 * the ordinary PKCE login runs, pinned to whichever tenant came out, and everything
 * that touches a credential happens on the identity provider's own pages.
 *
 * ─── Why the picker is a callback ──────────────────────────────────────────────
 *
 * The security-relevant part of this flow is the ORDER: resolve before you pin, pin
 * before you authorize, and never let a tenant the user was not offered reach the
 * authorize request. That has to be identical on all six surfaces, so it lives
 * here. The rendering has nothing in common between a phone and a 320px Outlook
 * taskpane, so it stays with the surface. Passing the picker in is what lets one
 * implementation of the ordering serve both.
 *
 * ─── What this deliberately does NOT do ────────────────────────────────────────
 *
 * It collects no password and shows no credential field. After the tenant is
 * decided it hands over to the provider, which then selects the right next factor
 * for that organization on its own: password, passkey, or that tenant's Entra or
 * Google button. That selection is not reimplemented here because it already exists
 * and is already per-organization.
 */

import type { IdentityAdapter } from "../adapters/identity.js";
import { type LoginOptions, type LoginResult, login } from "./login.js";
import {
  type DiscoverTenantsOptions,
  discoverTenants,
  type TenantOption,
} from "./tenant-discovery.js";

export interface EmailFirstOptions extends Omit<LoginOptions, "orgId" | "loginHint"> {
  /**
   * Render the tenant picker and resolve with the user's choice.
   *
   * Called ONLY when more than one tenant matched, so a single-tenant user — which
   * is very nearly all of them — never sees a flash of a chooser. Reject to
   * abandon the sign-in; that rejection propagates unchanged and no authorize
   * request is started.
   *
   * The returned tenant MUST be one of the offered options. Returning a hand-built
   * object is rejected rather than honoured, because pinning a login to a tenant
   * the user was never shown is a routing decision made by a bug.
   */
  onTenantChoice: (tenants: TenantOption[]) => TenantOption | Promise<TenantOption>;
  /** Transport, interim API key and abort signal for the discovery call. */
  discovery?: DiscoverTenantsOptions;
}

export interface EmailFirstResult extends LoginResult {
  /**
   * The tenant this session was pinned to, or `null` when discovery found none and
   * the provider resolved the user's home organization instead.
   */
  tenant: TenantOption | null;
}

/**
 * Resolve the tenant behind an address, then sign in against it.
 *
 * Discovery failure propagates: "we could not look up your tenant" is not the same
 * as "you have none", and proceeding as though it were would sign the user into the
 * wrong place.
 */
export async function loginEmailFirst(
  identity: IdentityAdapter,
  email: string,
  options: EmailFirstOptions,
): Promise<EmailFirstResult> {
  const { onTenantChoice, discovery, ...loginOptions } = options;

  const tenants = await discoverTenants(email, discovery);

  const tenant = await selectTenant(tenants, onTenantChoice);

  const result = await login(identity, {
    ...loginOptions,
    // Absent when no tenant matched: `login` skips the org scope entirely, leaving
    // the provider to resolve the home org. See {@link selectTenant}.
    orgId: tenant?.orgId,
    loginHint: email,
  });

  return { ...result, tenant };
}

/**
 * Decide which tenant to pin to, asking the user only when that is ambiguous.
 *
 * The zero-match case returns `null` rather than throwing, and that is a security
 * decision as much as a usability one. Throwing would give the caller a distinct,
 * user-visible outcome for "this address is unknown to us", which turns the login
 * screen into an account-existence oracle for anyone who can type addresses into
 * it. It would also lock out a legitimate user who exists in the instance's default
 * organization but in none of our tenants. Signing in unpinned covers both: the
 * provider decides, and an address we do not know looks exactly like one we do.
 */
async function selectTenant(
  tenants: TenantOption[],
  choose: EmailFirstOptions["onTenantChoice"],
): Promise<TenantOption | null> {
  if (tenants.length === 0) return null;
  if (tenants.length === 1) return tenants[0];

  const chosen = await choose(tenants);

  // Identity is not required — a surface may reasonably map options through its own
  // view model and hand back an equal value rather than the same reference.
  const offered = tenants.find(t => t.orgId === chosen?.orgId);
  if (!offered) {
    throw new Error("The chosen tenant is not one of the tenants that were offered.");
  }
  return offered;
}
