/**
 * Resolve which BlockBrain tenants an e-mail address belongs to.
 *
 * This is the "hidden" box in the email-first login diagram: the user types an
 * address and nothing else, and the tenant is worked out behind the screen. It runs
 * BEFORE anybody is authenticated, which is what makes it the single largest new
 * attack surface the email-first design introduces, and why the notes below are
 * about exposure rather than about mapping fields.
 *
 * ─── This endpoint needs hardening before the flow leans on it ──────────────────
 *
 * `GET /tenant-via-email/list-tenant` already exists in blocky and is guarded only
 * by `check_api_key`, a comparison against one global static secret that is shipped
 * inside the mobile app binary. That is not an authentication boundary, so treat
 * this route as public. As it stands today it answers 200 with tenant data for an
 * address it knows and 404 `Email not found` for one it does not, which is a clean
 * per-address account-existence oracle, and it discloses the internal
 * `zitadelOrgId` along the way. There is no rate limiting.
 *
 * The client half of the mitigation lives here: an unknown address resolves to an
 * empty list rather than throwing, so a caller cannot accidentally turn the two
 * cases into two different code paths, two different error dialogs, or two
 * different response times. The server half — uniform responses and timing, per-IP
 * and per-address rate limits, and returning the minimum needed to route a login —
 * is not something the SDK can enforce and has to land in blocky.
 *
 * ─── Do not borrow Zitadel's uniqueness guarantee ──────────────────────────────
 *
 * Zitadel's verified organization domains are globally unique per instance. The
 * `verified_domain` this endpoint matches on lives in blocky's own tenant registry
 * and is a DIFFERENT namespace with no enforced correspondence. Two BlockBrain
 * tenants can carry the same value, so "exactly one result" is a property of our
 * data, not a guarantee we inherit. The picker must stay capable of showing more
 * than one option.
 */

import { BBApiError } from "../api/errors.js";
import { createFetchTransport, type Transporter } from "../api/transport.js";

/** One tenant a user may sign in to, in the shape the picker renders. */
export interface TenantOption {
  /**
   * The Zitadel organization id.
   *
   * This is the tenant-routing value: it becomes `organization` on the Login v2
   * handoff and the acting org on subsequent API calls.
   */
  orgId: string;
  /** Display name for the picker. */
  tenantName: string;
  /** The tenant's BlockBrain domain, shown under the name to disambiguate. */
  domain: string;
}

export interface DiscoverTenantsOptions {
  /** Injected for tests and for hosts that cannot use global `fetch`. */
  transport?: Transporter;
  /**
   * The shared `x-api-key` the current route still requires.
   *
   * Optional because it is interim: the hardened endpoint should not need a shared
   * secret at all, and the one in use today is extractable from any shipped client.
   * Callers should treat whatever they pass here as public.
   */
  apiKey?: string;
  signal?: AbortSignal;
}

/** blocky wraps most responses as `{ code, key, body }`, but not every route does. */
type Envelope<T> = { body?: T } | T;

type RawTenant = {
  domain?: string;
  zitadelOrgId?: string;
  tenantName?: string;
};

const DISCOVERY_PATH = "/tenant-via-email/list-tenant";

function unwrap(json: Envelope<RawTenant[]>): RawTenant[] {
  if (Array.isArray(json)) return json;
  return Array.isArray(json.body) ? json.body : [];
}

/**
 * Look up the tenants behind an e-mail address.
 *
 * Resolves to an empty list when the address is unknown. Rejects when the lookup
 * itself failed, because "we could not ask" and "there is nobody here" must not
 * look the same to the caller: the first should be retried and explained, the
 * second should move the user forward.
 */
export async function discoverTenants(
  email: string,
  options?: DiscoverTenantsOptions,
): Promise<TenantOption[]> {
  const trimmed = email.trim();
  if (!trimmed) {
    throw new BBApiError("An e-mail address is required to resolve a tenant.", 0, {
      endpoint: DISCOVERY_PATH,
      kind: "network",
    });
  }

  const transport = options?.transport ?? createFetchTransport();
  const res = await transport.send({
    host: "blocky",
    path: DISCOVERY_PATH,
    method: "GET",
    query: { email: trimmed },
    headers: options?.apiKey ? { "x-api-key": options.apiKey } : undefined,
    signal: options?.signal,
  });

  // The unknown-address answer. Deliberately NOT an error: see the header note.
  if (res.status === 404) return [];

  if (!res.ok) {
    // The address is not echoed into the message — it is the input an attacker
    // controls and the one value most likely to end up in a log line.
    throw new BBApiError("Tenant discovery failed.", res.status, { endpoint: DISCOVERY_PATH });
  }

  const json = await res.json<Envelope<RawTenant[]>>();

  return unwrap(json).flatMap(t => {
    // A tenant with no org id cannot route a login. Pinning `organization` to an
    // empty value fails late, inside Zitadel, with an error the user cannot act on,
    // so drop it here rather than render an option that cannot work.
    const orgId = t.zitadelOrgId?.trim();
    if (!orgId) return [];
    return [{ orgId, tenantName: t.tenantName ?? "", domain: t.domain ?? "" }];
  });
}
