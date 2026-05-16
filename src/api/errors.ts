/**
 * Error thrown by SDK API calls on non-2xx HTTP responses or response-parsing failures.
 * Use `instanceof BBApiError` and check `.statusCode` to handle specific cases.
 */
export class BBApiError extends Error {
  readonly statusCode: number;
  readonly endpoint?: string;
  readonly responseBody?: unknown;

  constructor(
    message: string,
    statusCode: number,
    options?: { endpoint?: string; responseBody?: unknown; cause?: unknown },
  ) {
    super(message);
    this.name = "BBApiError";
    this.statusCode = statusCode;
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
