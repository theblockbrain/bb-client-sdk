/**
 * The bridge from an `AuthContext` to the {@link Transporter} — internal.
 *
 * PDEV-7337 migrates the endpoint modules off bare `fetch` without moving a
 * single signature: every function stays `(ctx, ...args) => Promise<T>`, so the
 * public-API snapshot does not move. That means the transporter has to arrive on
 * `ctx`, and these helpers are where it is resolved.
 */

import { trackApiError } from "../analytics/index.js";
import type { AuthContext } from "../settings/auth-mode.js";
import { BBApiError } from "./errors.js";
import {
  createFetchTransport,
  type Transporter,
  type TransportRequest,
  type TransportResponse,
} from "./transport.js";

/**
 * Resolve the transporter for a context.
 *
 * ⚠️ **`ctx.baseUrl` must override the `blocky` host, and this is the whole
 * reason this helper exists rather than each module calling
 * `createFetchTransport()` itself.**
 *
 * In OAuth mode `baseUrl` is pinned to `OAUTH_BACKEND_URL`, which is exactly
 * `DEFAULT_HOSTS.blocky` — so nothing changes. In **api-key mode `baseUrl` is
 * `settings.bbUrl`**: a self-hosted or QA instance. Routing those calls at
 * `DEFAULT_HOSTS.blocky` would send a self-hosted customer's traffic, bearing a
 * valid token, to production. Not a 404 — a silent wrong-host success.
 *
 * `ctx.hosts` is spread last so an explicit per-host override still wins; it is
 * the newer and more precise mechanism (PDEV-7332).
 *
 * A transporter is built per call rather than cached. `createFetchTransport` is
 * a config merge and a closure, which is nothing beside the request it wraps,
 * and caching would mean keying a module-level map on a `ctx` that React
 * surfaces recreate every render.
 */
function transporterFor(ctx: AuthContext): Transporter {
  return ctx.transport ?? createFetchTransport({ hosts: { blocky: ctx.baseUrl, ...ctx.hosts } });
}

/**
 * Send a request. Does **not** throw on a non-2xx — mirroring the transport's
 * own contract, because whether a 404 is an error belongs to the endpoint
 * (`discoverFrontendUrls` treats one as "no data"). Use {@link requestJson}
 * unless you need that distinction.
 */
export function request(ctx: AuthContext, req: TransportRequest): Promise<TransportResponse> {
  return transporterFor(ctx).send(req);
}

/**
 * Send a request, throw {@link BBApiError} on a non-2xx, and parse the JSON body.
 *
 * Replaces the ~12 lines of identical non-2xx boilerplate that every endpoint
 * carried. The thrown error keeps `statusCode` + `endpoint` so `trackApiError`
 * can forward the `api_error` event (invariant E), and `responseBody` is
 * attached but never interpolated into the message — it can echo secrets.
 */
export async function requestJson<T>(ctx: AuthContext, req: TransportRequest): Promise<T> {
  const res = await request(ctx, req);
  await throwIfNotOk(res, req.path);
  return res.json<T>();
}

/**
 * Throw `BBApiError` when a {@link TransportResponse} is non-2xx.
 *
 * The body is read for diagnostics only, and a body that is not JSON is not
 * itself an error — the failure being reported is the status.
 *
 * **This is the SDK's single `api_error` emit point (PDEV-7009).** WS9 asks for
 * telemetry emitted "from ONE point — inside the WS2 transport seam — not per
 * call site", and this is the place that became possible once PDEV-7338
 * collapsed the two error paths into one. Every non-2xx from every endpoint on
 * every host now passes through here, so no endpoint has to remember to
 * instrument itself and none can drift.
 *
 * `trackApiError` forwards only `statusCode` and `endpoint`. It never forwards
 * `responseBody`, which can echo a token (invariant D), and it is a no-op with
 * no adapter registered and swallows adapter faults — so it cannot alter what
 * this function throws.
 */
export async function throwIfNotOk(res: TransportResponse, endpoint: string): Promise<void> {
  if (res.ok) return;

  let responseBody: unknown;
  try {
    responseBody = await res.json<unknown>();
  } catch {
    /* error bodies are frequently HTML or empty */
  }

  const error = new BBApiError(`API ${res.status} at ${endpoint}`, res.status, {
    endpoint,
    responseBody,
  });

  // Fire-and-forget: emitted before the throw so the signal survives a caller
  // that swallows the error, and deliberately not awaited — telemetry must never
  // sit on the critical path of a failing request.
  trackApiError(error);

  throw error;
}
