import type { BBMessageKey } from "../i18n/keys.js";
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

// ─── L9 · error taxonomy: one description, one retry rule ─────────────────────

/** A failure described for a human, plus whether trying again could help. */
export interface BBErrorDescription {
  /**
   * Stable key for this condition (L12). The SDK owns the vocabulary; a surface
   * maps it to its own translation. `title`/`detail` remain as English defaults so
   * a surface that has not wired i18n still renders something sensible.
   */
  key: BBMessageKey;
  /** Short, user-facing. Safe to render directly. */
  title: string;
  /** One sentence on what to do next. Never carries server text. */
  detail: string;
  /** True when the same request could plausibly succeed later. */
  retryable: boolean;
}

/**
 * Describe a failure for a user.
 *
 * Exists because the same status ladder was being re-written per surface —
 * `ms-outlook-addin` carries three near-identical copies in one file — and they
 * drift. A shared map means a wording fix lands everywhere at once.
 *
 * Deliberately ignores `responseBody` and the error message. Server text can echo
 * a submitted grant or an internal detail, and this output is rendered, so
 * anything derived from it would be a leak with a UI attached (invariant D).
 * `kind` is checked before `statusCode` because a network drop and a timeout both
 * report `0` and need different advice.
 */
export function describeBBApiError(err: unknown): BBErrorDescription {
  if (!isBBApiError(err)) {
    return {
      key: "error.unknown",
      title: "Something went wrong",
      detail: "An unexpected error occurred. Please try again.",
      retryable: true,
    };
  }

  switch (err.kind) {
    case "network":
      return {
        key: "error.offline",
        title: "No connection",
        detail: "The request could not reach the server. Check your connection.",
        retryable: true,
      };
    case "timeout":
      return {
        key: "error.timeout",
        title: "Timed out",
        detail: "The server took too long to respond. Please try again.",
        retryable: true,
      };
    case "aborted":
      return {
        key: "error.cancelled",
        title: "Cancelled",
        detail: "The request was cancelled.",
        retryable: false,
      };
    case "parse":
      return {
        key: "error.badResponse",
        title: "Unexpected response",
        detail: "The server replied in a format the app did not expect.",
        retryable: false,
      };
    default:
      return describeHttpStatus(err.statusCode);
  }
}

/**
 * Whether an HTTP status is worth retrying. **The single source for that rule** —
 * consumed by {@link describeBBApiError} (and therefore {@link isRetryableBBError}) and
 * by the transport's retry loop, so the two cannot drift.
 *
 * Status-only on purpose. The transport evaluates this against **every** response,
 * including 2xx, so the predicate has to be closed over `< 400`: a permissive default
 * would make the transport discard successful responses and retry them until its
 * attempt budget ran out. Only a genuine failure status can be retryable.
 *
 * `429` is the one retryable 4xx — the condition is time, not the request. `401` is
 * never retryable: that path belongs to the auth-refresh flow, and retrying it is how a
 * login loop starts.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

function describeHttpStatus(status: number): BBErrorDescription {
  const retryable = isRetryableStatus(status);

  if (status === 401) {
    return {
      key: "error.signedOut",
      title: "Signed out",
      detail: "Your session expired. Please sign in again.",
      retryable,
    };
  }
  if (status === 403) {
    return {
      key: "error.forbidden",
      title: "Not allowed",
      detail: "Your account does not have access to this.",
      retryable,
    };
  }
  if (status === 404) {
    return {
      key: "error.notFound",
      title: "Not found",
      detail: "That item no longer exists.",
      retryable,
    };
  }
  if (status === 429) {
    // Retryable, unlike every other 4xx — the condition is time, not the request.
    return {
      key: "error.rateLimited",
      title: "Too many requests",
      detail: "Please wait a moment and retry.",
      retryable,
    };
  }
  // No special case for 503. It was documented as "capability not configured",
  // but that meaning has no source: Botticelli emits 503 nowhere (0 occurrences
  // across packages/, in any language or config) and no consumer branches on it.
  // The claim entered as a comment in a README example (commit d193e66) and was
  // later promoted into the /sdk skill as if it were a contract.
  //
  // With no application path emitting it, the realistic source is infrastructure —
  // ingress or mesh mid-rollout, a pod not ready, an LB with no healthy upstream —
  // which is transient and retryable, exactly what RFC 9110 says. A domain
  // condition must not ride on a status the application does not exclusively own:
  // the client cannot tell "unconfigured" from "no upstream". Signal it in a typed
  // body field instead, as `oauthErrorCode` reads RFC 6749 §5.2 codes.
  if (status >= 500) {
    return {
      key: "error.server",
      title: "Server error",
      detail: "The server had a problem. Please try again.",
      retryable,
    };
  }
  if (status >= 400) {
    return {
      key: "error.rejected",
      title: "Request rejected",
      detail: "The request was not accepted. Please check your input.",
      retryable,
    };
  }
  return {
    key: "error.unknown",
    title: "Something went wrong",
    detail: "An unexpected error occurred. Please try again.",
    retryable,
  };
}

/**
 * Whether a failed request is worth retrying — the single source for that rule.
 *
 * Framework-agnostic, so `./react`'s query client and any surface's error UI share
 * one rule instead of two similar-looking ladders. 401 is never retried here: that
 * path belongs to the auth-refresh flow, and retrying it is how a login loop starts.
 *
 * The transport now shares the rule too: its retry loop calls
 * {@link isRetryableStatus}, the same predicate `describeHttpStatus` reads, so the
 * query client, the transport and the error UI agree **by construction** rather than
 * by three similar-looking ladders. It previously kept a private `429 || 5xx` copy;
 * that copy agreed on every status `>= 400` but nothing enforced it.
 *
 * Note the asymmetry that makes this safe: the shared predicate is **status-only** and
 * closed over `< 400`. This function is not — it adds the `kind` cases (`network` and
 * `timeout` retryable, `aborted` and `parse` not), which a status cannot express, and
 * treats a non-`BBApiError` as retryable. So the transport takes the status rule and
 * nothing else, which is exactly what a response-level check should see.
 */
export function isRetryableBBError(err: unknown): boolean {
  return describeBBApiError(err).retryable;
}
