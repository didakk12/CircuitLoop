/**
 * Session authentication.
 *
 * `requireAuth` is the single gate in front of every data route — it reads the
 * httpOnly session cookie, verifies the JWT, confirms the user still exists,
 * and attaches them to the request. Downstream handlers can then treat
 * `req.user` as guaranteed present.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

import * as authService from "../services/authService.js";
import type { User } from "../types/entities.js";
import { UnauthorizedError } from "../utils/errors.js";

/** Name of the httpOnly cookie carrying the session JWT. */
export const SESSION_COOKIE_NAME = "circuitloop_session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. Present on every authenticated route, absent otherwise. */
      user?: User;
    }
  }
}

export const requireAuth: RequestHandler = (req: Request, _res: Response, next: NextFunction): void => {
  void (async () => {
    try {
      const token: unknown = (req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE_NAME];
      if (typeof token !== "string" || token.length === 0) {
        throw new UnauthorizedError();
      }

      const userId = authService.verifyToken(token);

      // A structurally valid token is not enough — the account may have been
      // deleted since it was issued, and a token outlives the row it names.
      const user = await authService.findUserById(userId);
      if (user === null) {
        throw new UnauthorizedError("Invalid or expired session");
      }

      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
  })();
};

/**
 * Returns the authenticated user, or throws if the route was not wrapped in
 * `requireAuth`.
 *
 * Exists so controllers never write `req.user!` — a non-null assertion would
 * silently produce `undefined` if a route were ever mounted without the
 * middleware, turning a missing gate into a confusing downstream crash rather
 * than a clear error here.
 */
export function requireUser(req: Request): User {
  if (req.user === undefined) {
    throw new UnauthorizedError();
  }
  return req.user;
}
