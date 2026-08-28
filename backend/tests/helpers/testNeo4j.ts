/**
 * Shared "connect once, skip gracefully if unreachable" boilerplate for
 * integration test files — the same pattern already proven in
 * `tests/schema.test.ts`, factored out so repository test files don't each
 * repeat it.
 */

import { settings } from "../../src/config/env.js";
import { initDriver } from "../../src/db/neo4jDriver.js";

export interface ConnectResult {
  reachable: boolean;
}

/** Call at module top-level (via top-level await) in each integration test file. */
export async function connectForTests(): Promise<ConnectResult> {
  try {
    await initDriver(settings.neo4j);
    return { reachable: true };
  } catch (error) {
    console.warn(
      `[testNeo4j] Neo4j not reachable at ${settings.neo4j.uri} — skipping integration tests. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { reachable: false };
  }
}
