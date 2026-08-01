/**
 * How a request failed.
 *
 * Before this existed, `BBApiError` was raised only for non-2xx responses and
 * everything else escaped untyped: a `fetch` rejection surfaced as a bare
 * `TypeError`, and there was no timeout in the SDK at all. Consumers compensated
 * by sniffing vendor internals — `b2b-webcomponents` branches on
 * `error?.code === 'ECONNABORTED'` and `error?.message?.includes('Network Error')`
 * to tell a timeout from a dropped connection. That is the fragility this absorbs.
 *
 * A field rather than sibling error classes (PDEV-7335 decision): sibling classes
 * would fall out of {@link isBBApiError}, which is public and which consumers
 * already branch on, so a network failure would silently stop being caught. A
 * discriminant keeps one guard and makes new kinds additive.
 *
 * - `http`    — a response arrived and was non-2xx. `statusCode` is the real status.
 * - `network` — no response at all: DNS, TLS, refused connection, offline.
 * - `timeout` — the transport's own deadline elapsed first.
 * - `aborted` — the caller's `AbortSignal` fired.
 * - `parse`   — a response arrived but its body was not the expected shape.
 *
 * `statusCode` is `0` for every kind except `http`.
 */
export type BBErrorKind = "http" | "network" | "timeout" | "aborted" | "parse";

/**
 * Error thrown by SDK API calls on non-2xx HTTP responses or response-parsing failures.
 * Use `instanceof BBApiError` and check `.statusCode` to handle specific cases.
 *
 * Check {@link BBApiError.kind} first when the distinction matters: `statusCode`
 * alone cannot tell a network drop from a timeout — both report `0`.
 */
export class BBApiError extends Error {
  readonly statusCode: number;
  /** How the request failed. Defaults to `"http"` — see {@link BBErrorKind}. */
  readonly kind: BBErrorKind;
  readonly endpoint?: string;
  readonly responseBody?: unknown;

  constructor(
    message: string,
    statusCode: number,
    options?: {
      endpoint?: string;
      responseBody?: unknown;
      cause?: unknown;
      kind?: BBErrorKind;
    },
  ) {
    super(message);
    this.name = "BBApiError";
    this.statusCode = statusCode;
    // Defaulted rather than required, so every existing construction site keeps
    // working and adding the field stays additive for callers.
    this.kind = options?.kind ?? "http";
    this.endpoint = options?.endpoint;
    this.responseBody = options?.responseBody;
    // Native cause-chaining (ES2022)
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Preserve prototype for instanceof to work across bundler realms
    Object.setPrototypeOf(this, BBApiError.prototype);
  }
}

/** Type guard for BBApiError. */
export function isBBApiError(err: unknown): err is BBApiError {
  return err instanceof BBApiError;
}
