/**
 * Wraps an async Express request handler so a rejected promise is forwarded
 * to `next(error)` instead of crashing the process. Express 4 (unlike 5)
 * doesn't do this automatically.
 */

import type { NextFunction, Request, Response } from "express";

export type AsyncRequestHandler<Req extends Request = Request, Res extends Response = Response> = (
  req: Req,
  res: Res,
  next: NextFunction,
) => Promise<void>;

export function asyncHandler<Req extends Request = Request, Res extends Response = Response>(
  handler: AsyncRequestHandler<Req, Res>,
) {
  return (req: Req, res: Res, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
