/**
 * Registration, login, and session-token issuing.
 *
 * The token is a signed JWT delivered in an httpOnly cookie (see
 * middleware/auth.ts and routes/auth.ts), so it is never readable by page
 * JavaScript and therefore not exfiltratable by an XSS bug the way a
 * localStorage token would be.
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { settings } from "../config/env.js";
import * as userRepository from "../repositories/userRepository.js";
import type { User } from "../types/entities.js";
import { ConflictError, UnauthorizedError } from "../utils/errors.js";

/**
 * Work factor for bcrypt. 12 is the common current default — deliberately
 * slow, which is the entire point for password hashing.
 *
 * Overridable purely so the test suite can drop it: at cost 12 every test
 * account costs hundreds of milliseconds of CPU, which slows the suite and
 * skews timing-sensitive tests elsewhere. Never lower it outside tests.
 */
const BCRYPT_ROUNDS = Number.parseInt(process.env.BCRYPT_ROUNDS ?? "12", 10);

export interface SessionTokenPayload {
  /** User id. Named `sub` to follow the registered JWT claim rather than inventing one. */
  sub: string;
}

export function issueToken(user: User): string {
  const payload: SessionTokenPayload = { sub: user.id };
  return jwt.sign(payload, settings.jwtSecret, {
    expiresIn: settings.jwtExpiresIn as jwt.SignOptions["expiresIn"],
  });
}

/**
 * Verifies a session token and returns the user id it names.
 *
 * @throws {UnauthorizedError} for every failure mode — expired, malformed,
 * wrong signature. The distinction is deliberately not surfaced: it tells a
 * caller nothing useful and tells an attacker whether their forgery attempt
 * was structurally valid.
 */
export function verifyToken(token: string): string {
  try {
    const decoded = jwt.verify(token, settings.jwtSecret) as SessionTokenPayload;
    if (typeof decoded.sub !== "string" || decoded.sub.length === 0) {
      throw new UnauthorizedError("Invalid session");
    }
    return decoded.sub;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }
    throw new UnauthorizedError("Invalid or expired session");
  }
}

export async function register(email: string, password: string): Promise<User> {
  const existing = await userRepository.findByEmail(email);
  if (existing !== null) {
    throw new ConflictError("An account with that email already exists");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    return await userRepository.create({ email, passwordHash });
  } catch (error) {
    // The unique-email constraint is the real guard: the check above races
    // against a concurrent signup with the same address, and only the database
    // can settle that atomically.
    if (error instanceof Error && /already exists|ConstraintValidationFailed/i.test(error.message)) {
      throw new ConflictError("An account with that email already exists");
    }
    throw error;
  }
}

/**
 * Verifies credentials.
 *
 * Runs a bcrypt comparison even when no account matches, so the response time
 * does not reveal whether the email is registered.
 */
export async function login(email: string, password: string): Promise<User> {
  const user = await userRepository.findByEmail(email);

  const hashToCompare =
    user?.passwordHash ?? "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
  const passwordMatches = await bcrypt.compare(password, hashToCompare);

  if (user === null || !passwordMatches) {
    throw new UnauthorizedError("Invalid email or password");
  }

  return user;
}

export async function findUserById(id: string): Promise<User | null> {
  return userRepository.findById(id);
}
