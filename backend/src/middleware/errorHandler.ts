/**
 * Central Express error-handling middleware. Every thrown/forwarded error
 * ends up here (via `asyncHandler` or `next(error)`) and is translated into
 * the `{"detail": ...}` JSON envelope the existing API contract uses
 * (BACKEND_IMPLEMENTATION_PLAN.md §11) — never a stack trace or raw
 * driver/library error leaked to the client.
 */

import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { AppError } from "../utils/errors.js";

function log(level: "WARN" | "ERROR", message: string): void {
  console.error(`[${new Date().toISOString()}] [${level}] ${message}`);
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (error instanceof AppError) {
    log("WARN", `${error.name}: ${error.message}`);
    res.status(error.statusCode).json({ detail: error.message });
    return;
  }

  if (error instanceof ZodError) {
    log("WARN", `Unvalidated ZodError reached errorHandler: ${error.message}`);
    res.status(400).json({ detail: error.issues.map((issue) => issue.message).join("; ") });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  log("ERROR", `Unhandled error: ${message}`);
  res.status(500).json({ detail: "Internal server error" });
};

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ detail: `No route for ${req.method} ${req.path}` });
}
