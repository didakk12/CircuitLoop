import type { CookieOptions, Request, Response } from "express";

import { settings } from "../config/env.js";
import { requireUser, SESSION_COOKIE_NAME } from "../middleware/auth.js";
import * as authService from "../services/authService.js";
import { toUserResponse } from "../types/dto.js";
import type { UserResponse } from "../types/dto.js";
import type { User } from "../types/entities.js";
import type { CredentialsBody } from "../validation/authSchemas.js";

/**
 * Cookie settings for the session token.
 *
 * - `httpOnly` keeps it out of reach of page JavaScript, so an XSS bug cannot
 *   read or exfiltrate the session.
 * - `sameSite: "lax"` blocks the cookie on cross-site form posts, which covers
 *   the CSRF cases that matter here without breaking normal navigation. This
 *   works because the frontend is served same-origin through the Vite proxy in
 *   development; a genuinely cross-site frontend would need `none` + `secure`.
 * - `secure` is configurable so http://localhost works in development and the
 *   cookie is HTTPS-only in production.
 */
function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: settings.cookieSecure,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function respondWithSession(res: Response<UserResponse>, user: User, status: number): void {
  res.cookie(SESSION_COOKIE_NAME, authService.issueToken(user), sessionCookieOptions());
  res.status(status).json(toUserResponse(user));
}

export async function register(
  req: Request<Record<string, never>, UserResponse, CredentialsBody>,
  res: Response<UserResponse>,
): Promise<void> {
  const user = await authService.register(req.body.email, req.body.password);
  respondWithSession(res, user, 201);
}

export async function login(
  req: Request<Record<string, never>, UserResponse, CredentialsBody>,
  res: Response<UserResponse>,
): Promise<void> {
  const user = await authService.login(req.body.email, req.body.password);
  respondWithSession(res, user, 200);
}

export function logout(_req: Request, res: Response): void {
  // Options must match those the cookie was set with, or the browser keeps it.
  res.clearCookie(SESSION_COOKIE_NAME, { ...sessionCookieOptions(), maxAge: undefined });
  res.status(204).send();
}

/** Who am I — lets the frontend restore a session on load without storing anything itself. */
export function me(req: Request, res: Response<UserResponse>): void {
  res.status(200).json(toUserResponse(requireUser(req)));
}
