/**
 * Short-lived Neo4j session/transaction management for the repository layer.
 *
 * Every repository function accepts an *optional* `QueryRunner` as its last
 * parameter:
 *   - Omitted (production path): the repository calls `readQuery`/`writeQuery`,
 *     which open a session, run the work inside a managed transaction
 *     (`session.executeRead`/`executeWrite` — retries transient errors per
 *     BACKEND_IMPLEMENTATION_PLAN.md §11), and always close the session.
 *   - Provided (test path): the caller's own transaction is used directly,
 *     uncommitted — tests open one transaction per test and roll it back in
 *     `afterEach`, so integration tests run against the real database with
 *     zero risk of leaving data behind. See BACKEND_IMPLEMENTATION_PLAN.md §18.
 *
 * `QueryRunner` is a minimal structural interface — both `Session` and
 * `ManagedTransaction`/`Transaction` from `neo4j-driver` satisfy it via their
 * `.run()` method, so repositories never need to know which one they got.
 */

import type { Result } from "neo4j-driver";

import { settings } from "../config/env.js";
import { getDriver } from "./neo4jDriver.js";

export interface QueryRunner {
  run<R extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    parameters?: Record<string, unknown>,
  ): Result<R>;
}

/** Opens a session, runs `work` inside a managed *read* transaction, always closes the session. */
export async function withReadSession<T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> {
  const session = getDriver().session({ database: settings.neo4j.database });
  try {
    return await session.executeRead((tx) => work(tx));
  } finally {
    await session.close();
  }
}

/** Opens a session, runs `work` inside a managed *write* transaction, always closes the session. */
export async function withWriteSession<T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> {
  const session = getDriver().session({ database: settings.neo4j.database });
  try {
    return await session.executeWrite((tx) => work(tx));
  } finally {
    await session.close();
  }
}

/**
 * Runs a read against the given `runner` if one was supplied (test path),
 * otherwise opens a short-lived read session (production path).
 */
export function readQuery<T>(
  runner: QueryRunner | undefined,
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> {
  return runner ? work(runner) : withReadSession(work);
}

/**
 * Runs a write against the given `runner` if one was supplied (test path),
 * otherwise opens a short-lived write session (production path).
 */
export function writeQuery<T>(
  runner: QueryRunner | undefined,
  work: (runner: QueryRunner) => Promise<T>,
): Promise<T> {
  return runner ? work(runner) : withWriteSession(work);
}
