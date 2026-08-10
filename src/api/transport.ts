/**
 * The WS2 transport seam (PDEV-7336) — the shape decided in PDEV-7335.
 *
 * `./api` used to call the global `fetch` directly at 28 sites, which baked a
 * browser / Node-20+ assumption into the core and was the reason `blocky-mobile`
 * and `b2b-webcomponents` could not use the SDK's request path at all. This
 * module is the injection point that removed that assumption.
 *
 * **Public and wired.** PDEV-7337 migrated the read-only endpoints and PDEV-7338
 * the writes plus the Agentic client, and `src/api/index.ts` exports
 * `createFetchTransport` along with every type here.
 *
 * This paragraph used to read "⚠️ NOT WIRED YET, ON PURPOSE ... deliberately
 * absent from `src/api/index.ts`", left over from when the seam landed on its own
 * ahead of the migrations. It stayed wrong through two releases and directly
 * contradicted the export comment sixty lines into `index.ts`. It is called out
 * rather than quietly deleted because a stale warning is worse than none: an
 * adopter reading this header reasonably concludes the transport is off limits
 * and rebuilds timeouts, retries and 401 replay by hand, which is exactly what
 * happened in `ms-word-addin`.
 *
 * ─── The three decisions that shaped this (full record: PDEV-7331, 2026-07-29) ───
 *
 * **1. Streaming is `AsyncIterable<string>`, never a `ReadableStream`.** The
 * constraint that decided it is the CHUNK TYPE, not the method surface: both SDK
 * parsers decode `Uint8Array`, but mobile's XHR source yields strings and b2b's
 * message path decodes to strings before reading. So the transport owns the
 * `TextDecoder` and hands out text. Mobile and b2b then need no adaptation at all,
 * and the `instanceof ReadableStream` failures that forced mobile to override
 * `global.ReadableStream` with `web-streams-polyfill` simply cannot occur, because
 * no stream object crosses the seam. Note `pipeThrough` is deliberately NOT
 * required: mobile implements it for the Vercel AI SDK, which it uses *instead of*
 * our parsers — ours only ever call `getReader()`.
 *
 * **2. Cancellation is a per-call `AbortSignal`. No keyed registry lives here.**
 * Mobile's `fetchWithXHRStream` already honours `init.signal`; its `XHRManager`
 * (`Map<threadId, …>`) is app-level UI state that rebuilds over `AbortController`
 * just as easily. A keyed registry in the SDK would be process-wide mutable state
 * keyed by a caller-supplied string — the bug class that disqualified a module
 * singleton in the first place.
 *
 * **3. Non-2xx does NOT throw here.** Deciding whether a 404 is an error is the
 * endpoint's call, not the transport's — `discoverFrontendUrls` (`tenant.ts:30`)
 * legitimately treats one as "no data" and returns `null`. The transport throws
 * only for failures with no HTTP response at all (network / timeout / aborted).
 * HTTP-status policy stays with `throwIfNotOk`, which PDEV-7338 makes universal
 * when it collapses the two error patterns.
 */

import { type BBHost, type BBHosts, DEFAULT_HOSTS } from "../config.js";
import { BBApiError, isRetryableStatus } from "./errors.js";
import { normalizeUrl } from "./url.js";

// ─── Hosts ────────────────────────────────────────────────────────────────────

// `BBHost` / `BBHosts` / `DEFAULT_HOSTS` are defined in `../config.js` (the leaf both
// `./api` and `./settings` can reach) and re-exported here so the transport reads as
// self-contained. Proxy mode is a URL **rewrite** (see {@link UrlRewrite}), not a
// fourth host — b2b rewrites an already-built URL rather than selecting an origin.
export type { BBHost, BBHosts };
export { DEFAULT_HOSTS };

/**
 * Deadline for non-streaming requests.
 *
 * Matches `b2b-webcomponents`' `TIMEOUT_REQUEST.NORMAL`, which is what runs in
 * production today. A tighter default would be the SDK inventing a policy that
 * breaks a live consumer — the slow routes are real (`ingest`, the
 * smart-processing / OCR family).
 *
 * Streaming requests get **no** timeout: a long agent turn legitimately outlives
 * any fixed deadline, and b2b's own streaming (via `EventSource`) is likewise
 * untimed. Cancel those with an `AbortSignal`.
 */
export const DEFAULT_TIMEOUT_MS = 300_000;

// ─── Request / response ───────────────────────────────────────────────────────

export type TransportMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type QueryValue = string | number | boolean | undefined;

export interface TransportRequest {
  readonly host: BBHost;
  /** Path only, leading slash, no origin. e.g. `"/cortex/completions/v2/user-input"`. */
  readonly path: string;
  readonly method: TransportMethod;
  /** `undefined` values are dropped rather than serialised as `"undefined"`. */
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The SDK sends only JSON strings and `FormData` (attachment upload). Note
   * `Content-Type` must NOT be set for `FormData` — the runtime derives the
   * multipart boundary from the body.
   */
  readonly body?: string | FormData;
  readonly signal?: AbortSignal;
  /** Overrides {@link DEFAULT_TIMEOUT_MS}. Ignored when `stream` is true. */
  readonly timeoutMs?: number;
  /** Ask for {@link TransportResponse.chunks} instead of a buffered body. */
  readonly stream?: boolean;
}

export interface TransportResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Keys are lower-cased — casing is not preserved consistently across fetch, XHR and EventSource. */
  readonly headers: Readonly<Record<string, string>>;
  /** Rejects with a `parse`-kind {@link BBApiError} when the body is not JSON. */
  json<T>(): Promise<T>;
  text(): Promise<string>;
  /**
   * Decoded text chunks. Present only when the request set `stream: true`.
   * See decision 1 in the module header for why this is not a `ReadableStream`.
   */
  readonly chunks?: AsyncIterable<string>;
}

// ─── The seam ─────────────────────────────────────────────────────────────────

export interface Transporter {
  send(req: TransportRequest): Promise<TransportResponse>;
}

/**
 * Rewrite the fully-built URL before it goes on the wire.
 *
 * Receives a parseable `URL` rather than `(host, path)` strings because b2b's
 * proxy rewrite needs `.pathname` **and** `.search`:
 *
 * ```ts
 * (url) => `${PROXY_URL}/wc/proxy${url.pathname}${url.search}`
 * ```
 *
 * A base-URL prepend cannot express that, which is why the hook takes the whole URL.
 */
export type UrlRewrite = (url: URL, host: BBHost) => string;

export interface TransportConfig {
  /** Merged over {@link DEFAULT_HOSTS}. */
  readonly hosts?: Partial<BBHosts>;
  readonly rewriteUrl?: UrlRewrite;
  /** Injected for tests and for runtimes whose global `fetch` is unsuitable. */
  readonly fetch?: typeof globalThis.fetch;
  /** Default deadline for non-streaming requests. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * Extra headers evaluated per request — b2b's `customHeaders` /
   * `getCustomHeaders()`. Applied first, so {@link TransportRequest.headers} wins
   * on a collision.
   */
  readonly headers?: () => Readonly<Record<string, string>>;
  /**
   * Retry policy for **idempotent** requests (PDEV-7340). Omitted, nothing retries.
   *
   * Deliberately not on by default: a silent retry changes the timing every
   * consumer already tuned around, and one of them streams. Opt in per surface.
   */
  readonly retry?: RetryPolicy;
  /**
   * Called once on a 401, to re-mint the bearer token (PDEV-7340).
   *
   * Return the new token to have the request replayed with it, or `null` to let
   * the 401 through. Returning `null` is the honest answer when the refresh
   * token is itself expired — retrying forever is how a login loop starts.
   *
   * **Wrap your refresh in `createRefreshGuard` before passing it here.** Ten
   * concurrent requests hitting an expired token will each land on a 401 and
   * each call this; without single-flight that is ten refreshes, and with a
   * rotating refresh token nine of them fail and log the user out. The transport
   * does not impose the guard because the guard belongs to the surface's token
   * store, which is where the new token has to be persisted anyway.
   */
  readonly onUnauthorized?: () => Promise<string | null>;
}

export interface RetryPolicy {
  /** Extra attempts after the first. Default 2. */
  readonly attempts?: number;
  /** First backoff, doubling per attempt. Default 300ms. */
  readonly baseDelayMs?: number;
}

/**
 * Methods safe to replay.
 *
 * GET only. PUT and DELETE are idempotent *by HTTP semantics*, but that is a
 * statement about the server's state, not about what our backends actually do —
 * and a replayed DELETE racing a concurrent create is a bad afternoon. A retried
 * POST could double-send a message. The conservative set is the one that cannot
 * surprise anyone. Note `getMessageList` is a POST and therefore never retried,
 * which is correct even though it only reads.
 */
/** Retries beyond the first attempt, when a policy is configured but omits it. */
const DEFAULT_RETRY_ATTEMPTS = 2;

/** Backoff base in ms; attempt N waits `base * 2 ** (N - 1)`. */
const DEFAULT_RETRY_BASE_DELAY_MS = 300;

const REPLAYABLE = new Set<TransportMethod>(["GET"]);

/** 5xx and 429 are worth a second go; a 4xx will fail identically. */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The default {@link Transporter}, over `fetch`.
 *
 * `fetch` is resolved lazily at call time, not at module load, so importing this
 * module is safe in a runtime that has no global `fetch` until a polyfill runs.
 */
export function createFetchTransport(config: TransportConfig = {}): Transporter {
  const hosts: BBHosts = { ...DEFAULT_HOSTS, ...config.hosts };

  return {
    async send(req: TransportRequest): Promise<TransportResponse> {
      const url = buildUrl(hosts, req, config.rewriteUrl);
      const streaming = req.stream === true;
      const timeoutMs = streaming
        ? null
        : (req.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const plan = planAbort(req.signal, timeoutMs);
      const doFetch = config.fetch ?? globalThis.fetch;

      // Every throwing path must dispose the plan. `dispose` clears the deadline
      // timer and detaches the caller-abort listener; leaking the timer keeps a
      // Node event loop alive for the rest of the timeout, and leaking the
      // listener accumulates handlers on a long-lived caller signal. Success is
      // handled separately per branch: buffered disposes after reading the body,
      // streaming hands `dispose` to `decodeChunks` to run at stream end.
      try {
        if (typeof doFetch !== "function") {
          throw new BBApiError(
            "No fetch implementation available. Pass one via TransportConfig.fetch.",
            0,
            { kind: "network", endpoint: req.path },
          );
        }

        let res = await attempt(doFetch, url, req, plan, config.retry);

        // ── 401 → refresh → replay once (PDEV-7340) ──────────────────────────
        // Once, never in a loop: if the fresh token also gets a 401 the problem is
        // authorisation, not staleness, and retrying is how a login loop starts.
        // Applies to streamed requests too — an expired token fails a stream just
        // as readily, and re-opening it is exactly what a surface would hand-roll.
        if (res.status === 401 && config.onUnauthorized) {
          const refreshed = await config.onUnauthorized();
          if (refreshed) {
            const replay: TransportRequest = {
              ...req,
              headers: { ...req.headers, Authorization: `Bearer ${refreshed}` },
            };
            res = await attempt(doFetch, url, replay, plan, config.retry);
          }
        }

        if (!streaming) {
          // Buffer inside send() so the deadline covers reading the body too, and so
          // the timer is always cleared exactly once. A TransportResponse is then a
          // plain value — trivial to fake in a test or produce from an XHR transport.
          const bodyText = await readBody(res, req, plan);
          plan.dispose();
          return makeBufferedResponse(res, req, bodyText);
        }

        return {
          status: res.status,
          ok: res.ok,
          headers: readHeaders(res),
          json: <T>() => parseJson<T>("", req.path),
          text: () => Promise.resolve(""),
          chunks: decodeChunks(res.body, plan.dispose),
        };
      } catch (err) {
        plan.dispose();
        throw err;
      }
    },
  };
}

/**
 * One request, plus retries for a replayable method.
 *
 * Retries a network failure or a 429/5xx, with doubling backoff. Never retries a
 * 4xx other than 429 — the same request will fail the same way — and never
 * retries a non-GET (see {@link REPLAYABLE}).
 *
 * The deadline is NOT reset per attempt: `plan` is created once in `send`, so
 * the whole retry sequence lives inside the caller's timeout. A retry that could
 * extend the deadline would make the timeout unbounded, which is the opposite of
 * what a timeout is for.
 */
/** Retries beyond the first attempt. Non-negative integer; unusable input → default. */
function clampAttempts(attempts: number | undefined): number {
  if (attempts === undefined || !Number.isFinite(attempts)) return DEFAULT_RETRY_ATTEMPTS;
  return Math.max(0, Math.trunc(attempts));
}

/** Backoff base in ms. Non-negative finite; unusable input → default. */
function clampDelay(baseDelayMs: number | undefined): number {
  if (baseDelayMs === undefined || !Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    return DEFAULT_RETRY_BASE_DELAY_MS;
  }
  return baseDelayMs;
}

async function attempt(
  doFetch: typeof globalThis.fetch,
  url: string,
  req: TransportRequest,
  plan: AbortPlan,
  policy: RetryPolicy | undefined,
): Promise<Response> {
  // Clamped because these are caller config. A negative or NaN `attempts` makes
  // `i <= extra` false on the first iteration, so the loop body never runs: the
  // request is never sent at all and the caller gets a fabricated "aborted"
  // error from the tail throw. Silently not sending is the worst failure mode
  // available, so an unusable value falls back rather than propagating.
  const extra = policy && REPLAYABLE.has(req.method) ? clampAttempts(policy.attempts) : 0;
  const baseDelay = clampDelay(policy?.baseDelayMs);

  let lastError: unknown;
  for (let i = 0; i <= extra; i++) {
    if (i > 0) {
      // Abort mid-backoff rather than sleeping through a cancellation.
      if (plan.signal?.aborted) break;
      await sleep(baseDelay * 2 ** (i - 1));
      if (plan.signal?.aborted) break;
    }

    try {
      const res = await doFetch(url, {
        method: req.method,
        headers: lowerKeys({ ...req.headers }),
        body: req.body,
        signal: plan.signal,
      });
      // `isRetryableStatus` is the shared predicate from ./errors.js, so this loop and
      // `describeBBApiError` cannot disagree. It is closed over `< 400`, which is what
      // stops this line discarding a 2xx: every response passes through here.
      if (i === extra || !isRetryableStatus(res.status)) return res;

      // This response is being thrown away. Cancel its body so the runtime can
      // release the connection instead of holding it until GC; `undici` warns
      // about exactly this. Optional-chained (a 204 has no body) and the
      // rejection is swallowed — failing to release is not worth losing the
      // retry over.
      res.body?.cancel().catch(() => {
        /* releasing is best-effort */
      });
    } catch (err) {
      // A timeout or a caller abort is terminal — only a transient network
      // failure is worth another go.
      if (plan.timedOut() || plan.signal?.aborted) throw toTransportError(err, req, plan);
      lastError = err;
      if (i === extra) throw toTransportError(err, req, plan);
    }
  }

  // Backoff was cut short by an abort. The cause is kept for the log — either the
  // failure that triggered the retry, or a placeholder when the earlier attempts
  // only returned retriable statuses — but it is NOT what decides the kind:
  // `toTransportError` reads `plan.signal.aborted`, because neither of those two
  // causes is named `AbortError` and both used to be filed as network failures.
  throw toTransportError(lastError ?? new Error("aborted"), req, plan);
}

// ─── Internals ────────────────────────────────────────────────────────────────

function buildUrl(hosts: BBHosts, req: TransportRequest, rewrite?: UrlRewrite): string {
  const base = normalizeUrl(hosts[req.host]);
  const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
  // NOTE (WS7 / PDEV-7372): React Native's built-in `URL` is incomplete. RN surfaces
  // need `react-native-url-polyfill` before they inject their own transport. Kept as
  // a documented adapter requirement rather than a hand-rolled string builder, since
  // `UrlRewrite` hands consumers a real `URL` by contract.
  const url = new URL(`${base}${path}`);

  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  return rewrite ? rewrite(url, req.host) : url.toString();
}

async function readBody(res: Response, req: TransportRequest, plan: AbortPlan): Promise<string> {
  try {
    return await res.text();
  } catch (cause) {
    plan.dispose();
    throw toTransportError(cause, req, plan);
  }
}

function makeBufferedResponse(
  res: Response,
  req: TransportRequest,
  bodyText: string,
): TransportResponse {
  return {
    status: res.status,
    ok: res.ok,
    headers: readHeaders(res),
    json: <T>() => parseJson<T>(bodyText, req.path),
    text: () => Promise.resolve(bodyText),
  };
}

function parseJson<T>(bodyText: string, endpoint: string): Promise<T> {
  try {
    return Promise.resolve(JSON.parse(bodyText) as T);
  } catch (cause) {
    return Promise.reject(
      new BBApiError(`Response body at ${endpoint} was not valid JSON`, 0, {
        kind: "parse",
        endpoint,
        cause,
      }),
    );
  }
}

function readHeaders(res: Response): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

/**
 * Decode a byte stream into text chunks — the single place the SDK owns a
 * `TextDecoder`, so that no other transport has to (decision 1).
 */
async function* decodeChunks(
  body: ReadableStream<Uint8Array> | null,
  dispose: () => void,
): AsyncIterable<string> {
  if (body === null) {
    dispose();
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) yield decoder.decode(value, { stream: true });
    }
    // Flush any multi-byte character straddling the final chunk boundary.
    const tail = decoder.decode();
    if (tail !== "") yield tail;
  } finally {
    reader.releaseLock();
    dispose();
  }
}

// ─── Abort + timeout ──────────────────────────────────────────────────────────

interface AbortPlan {
  readonly signal: AbortSignal | undefined;
  /** True once the transport's own deadline fired, which distinguishes it from a caller abort. */
  readonly timedOut: () => boolean;
  /**
   * Declared as a function-typed property rather than a method, because
   * `decodeChunks` receives it detached from the plan. A method shorthand here
   * would be an unbound-`this` hazard.
   */
  readonly dispose: () => void;
}

/**
 * Combine the caller's signal with the transport's deadline into one signal.
 *
 * Hand-rolled rather than `AbortSignal.any()`, which is ES2024 and not in this
 * package's `lib` (`ES2022` + `DOM`). The mutable `timedOut` flag is the one piece
 * of state here and it stays local to the closure.
 */
function planAbort(caller: AbortSignal | undefined, timeoutMs: number | null): AbortPlan {
  if (caller === undefined && timeoutMs === null) {
    return { signal: undefined, timedOut: () => false, dispose: () => {} };
  }

  const controller = new AbortController();
  let timedOut = false;

  const timer =
    timeoutMs === null
      ? null
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);

  const forwardAbort = () => controller.abort();

  if (caller !== undefined) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener("abort", forwardAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      caller?.removeEventListener("abort", forwardAbort);
    },
  };
}

function toTransportError(cause: unknown, req: TransportRequest, plan: AbortPlan): BBApiError {
  // `endpoint` carries the path, never the built URL — the URL may hold query
  // params, and error messages must not become a place tokens can surface.
  const endpoint = req.path;

  if (plan.timedOut()) {
    return new BBApiError(`Request to ${endpoint} timed out`, 0, {
      kind: "timeout",
      endpoint,
      cause,
    });
  }

  // An aborted plan counts as much as an `AbortError` cause, because a caller's
  // cancellation does not always arrive as one. `attempt`'s tail throw is reached
  // ONLY by breaking out of the backoff on `plan.signal.aborted`, and what it
  // carries is either a synthetic `Error("aborted")` or the previous attempt's
  // network failure — neither is named `AbortError`. Both used to land as
  // `kind: "network"`, so a consumer's cancellation guard missed them and its
  // error banner said "No connection" for a request the user had cancelled;
  // `ms-word-addin`, whose search-as-you-type hooks abort on every keystroke, hit
  // it as soon as it enabled retry. Checked after `plan.timedOut()` on purpose:
  // the deadline aborts this same signal, and a timeout is not a cancellation.
  if (isAbortError(cause) || plan.signal?.aborted === true) {
    return new BBApiError(`Request to ${endpoint} was aborted`, 0, {
      kind: "aborted",
      endpoint,
      cause,
    });
  }

  return new BBApiError(`Network request to ${endpoint} failed`, 0, {
    kind: "network",
    endpoint,
    cause,
  });
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}
