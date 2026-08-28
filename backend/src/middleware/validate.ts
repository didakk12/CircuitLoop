/**
 * Request validation middleware built on zod. On success, `req.body`/
 * `req.query` is replaced with the parsed (and type-coerced/defaulted)
 * value; on failure, a `ValidationError` is forwarded to `errorHandler`,
 * which turns it into a `400 {"detail": ...}` response — matching the
 * `{"detail": ...}` convention the existing API contract already uses
 * (BACKEND_IMPLEMENTATION_PLAN.md §11).
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodType } from "zod";

import { ValidationError } from "../utils/errors.js";

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ");
}

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new ValidationError(formatZodError(result.error)));
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodType<T>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(new ValidationError(formatZodError(result.error)));
      return;
    }
    // Express types req.query as ParsedQs; the validated, narrower shape is
    // what handlers actually want, so we deliberately widen the assignment.
    req.query = result.data as unknown as Request["query"];
    next();
  };
}

/**
 * Multer (per Phase 4's upload endpoint) leaves `req.file` simply
 * `undefined` if the client didn't send the expected field — it's not a
 * Multer error, so it wouldn't otherwise be caught anywhere. This turns
 * that into the same `ValidationError` -> `400 {"detail": ...}` path every
 * other bad request already goes through.
 */
export function requireUploadedFile(fieldName: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.file) {
      next(new ValidationError(`No image file provided (expected multipart field '${fieldName}')`));
      return;
    }
    next();
  };
}
