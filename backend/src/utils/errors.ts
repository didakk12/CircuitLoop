/**
 * Typed application errors. Repositories return `null` for "not found" —
 * it's the service layer's job to translate that into a `NotFoundError`,
 * keeping repositories free of HTTP-flavored concerns. `errorHandler`
 * middleware (`middleware/errorHandler.ts`) turns any `AppError` into the
 * `{"detail": message}` envelope, matching the existing API convention
 * (BACKEND_IMPLEMENTATION_PLAN.md §11).
 */

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;

  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * The caller is not authenticated — no session cookie, or one that is expired,
 * malformed, or signed with a different secret.
 *
 * Deliberately carries a generic message: distinguishing "no such account"
 * from "wrong password" at login would let an attacker enumerate registered
 * email addresses.
 */
export class UnauthorizedError extends AppError {
  readonly statusCode = 401;

  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * The caller is authenticated but the resource is not theirs.
 *
 * Note that ownership checks in this codebase intentionally raise
 * `NotFoundError` rather than this, so a probing user cannot tell an existing
 * scan they do not own from one that does not exist. This exists for cases
 * where the resource's existence is not itself sensitive.
 */
export class ForbiddenError extends AppError {
  readonly statusCode = 403;

  constructor(message = "You do not have access to this resource") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends AppError {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Raised when a call to an internal upstream service (the Python ML
 * service, per ML_SERVICE_INTEGRATION_PLAN.md §5/§8) fails. Unlike its
 * siblings above, the status code isn't fixed — it varies by failure kind,
 * per the plan's explicit two-code scheme: `503` when the service couldn't
 * be reached at all or timed out, `502` when it was reached but returned
 * an error or a response that failed shape validation.
 */
export class UpstreamServiceError extends AppError {
  readonly statusCode: 502 | 503;
  /** The upstream's own `error` field, if it responded with one — preserved for callers that want finer-grained handling than the generic message. */
  readonly upstreamError: string | undefined;
  /** The upstream's own `detail` field, if it sent one — lets a caller (e.g. detectionService) build a specific, user-facing message instead of parsing it back out of `message`. */
  readonly upstreamDetail: string | undefined;

  constructor(statusCode: 502 | 503, message: string, upstreamError?: string, upstreamDetail?: string) {
    super(message);
    this.name = "UpstreamServiceError";
    this.statusCode = statusCode;
    this.upstreamError = upstreamError;
    this.upstreamDetail = upstreamDetail;
  }
}
