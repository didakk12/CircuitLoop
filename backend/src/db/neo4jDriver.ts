/**
 * Neo4j driver lifecycle: initialization, reuse, connection error handling,
 * and graceful shutdown.
 *
 * Ports the driver-lifecycle design from `BACKEND_IMPLEMENTATION_PLAN.md`
 * §17.1 to TypeScript. There is exactly one `Driver` per process — it is
 * created once at application startup (`initDriver`, called from
 * `src/index.ts`'s startup sequence) and every other module obtains it via
 * `getDriver()` rather than constructing a new one. The `neo4j-driver`
 * package already pools connections internally per `Driver` instance, so
 * "reuse" here means "reuse the one `Driver`", not "reuse a session" —
 * sessions are cheap and short-lived, opened per unit of work by callers.
 */

import neo4j, { type Driver } from "neo4j-driver";

import type { Neo4jSettings } from "../config/env.js";

let driver: Driver | undefined;

/**
 * Creates and verifies a single, process-wide driver instance. Must be
 * called exactly once, from the application's startup sequence — never
 * per-request.
 *
 * @throws {Error} with a specific, actionable message when authentication
 * fails or the database is unreachable, so misconfiguration is obvious
 * immediately rather than surfacing as a generic connection error later.
 */
export async function initDriver(neo4jSettings: Neo4jSettings): Promise<Driver> {
  const newDriver = neo4j.driver(
    neo4jSettings.uri,
    neo4j.auth.basic(neo4jSettings.username, neo4jSettings.password),
  );

  try {
    await newDriver.verifyConnectivity();
  } catch (error) {
    await newDriver.close();
    throw toStartupError(error, neo4jSettings.uri);
  }

  driver = newDriver;
  return newDriver;
}

/** Translates a raw driver connectivity error into a clear, actionable one. */
function toStartupError(error: unknown, uri: string): Error {
  const code = isNeo4jError(error) ? error.code : undefined;

  if (code !== undefined && code.includes("Unauthorized")) {
    return new Error(
      "Neo4j authentication failed — check NEO4J_USER/NEO4J_PASSWORD in backend/.env",
      { cause: error },
    );
  }

  if (code === "ServiceUnavailable" || code === undefined) {
    return new Error(
      `Could not reach Neo4j at ${uri} — is the database running and NEO4J_URI correct?`,
      { cause: error },
    );
  }

  return new Error(`Failed to connect to Neo4j at ${uri}: ${code}`, { cause: error });
}

function isNeo4jError(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  );
}

/**
 * Returns the shared driver instance. Repositories and other database
 * consumers call this to obtain a session — they never construct a
 * `Driver` themselves.
 *
 * @throws {Error} if called before `initDriver()` has completed.
 */
export function getDriver(): Driver {
  if (driver === undefined) {
    throw new Error("Neo4j driver not initialized — initDriver() must run at app startup");
  }
  return driver;
}

/**
 * Closes the shared driver and releases its connection pool. Called from
 * the application's shutdown sequence (SIGINT/SIGTERM handlers in
 * `src/index.ts`) so the process exits cleanly instead of leaving open
 * sockets behind.
 */
export async function closeDriver(): Promise<void> {
  if (driver !== undefined) {
    await driver.close();
    driver = undefined;
  }
}
