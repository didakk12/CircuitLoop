import { afterAll, describe, expect, it } from "vitest";

import { settings } from "../src/config/env.js";
import { closeDriver, getDriver, initDriver } from "../src/db/neo4jDriver.js";
import { ensureConstraintsAndIndexes } from "../src/db/schema.js";

const EXPECTED_CONSTRAINT_NAMES = [
  "scan_id_unique",
  "component_id_unique",
  "testresult_id_unique",
  "command_id_unique",
  "healthreport_id_unique",
  "agent_id_unique",
];

const EXPECTED_INDEX_NAMES = [
  "component_type_index",
  "component_status_index",
  "component_salvage_priority_index",
  "scan_timestamp_index",
  "command_status_index",
  "healthreport_status_index",
];

let neo4jReachable = true;
let connectError: unknown;

try {
  await initDriver(settings.neo4j);
} catch (error) {
  neo4jReachable = false;
  connectError = error;
  console.warn(
    `[schema.test.ts] Neo4j not reachable at ${settings.neo4j.uri} — skipping integration tests. ` +
      `Cause: ${error instanceof Error ? error.message : String(error)}`,
  );
}

describe.skipIf(!neo4jReachable)("Neo4j schema bootstrap (integration)", () => {
  afterAll(async () => {
    await closeDriver();
  });

  it("connects and verifies connectivity", () => {
    expect(getDriver()).toBeDefined();
    expect(connectError).toBeUndefined();
  });

  it("creates constraints and indexes idempotently (safe to run twice)", async () => {
    await expect(ensureConstraintsAndIndexes(getDriver(), settings.neo4j.database)).resolves.toBeUndefined();
    await expect(ensureConstraintsAndIndexes(getDriver(), settings.neo4j.database)).resolves.toBeUndefined();
  });

  it("registers every expected uniqueness constraint", async () => {
    const session = getDriver().session({ database: settings.neo4j.database });
    try {
      const result = await session.run<{ names: string[] }>(
        "SHOW CONSTRAINTS YIELD name RETURN collect(name) AS names",
      );
      const names = result.records[0]?.get("names") ?? [];
      for (const expected of EXPECTED_CONSTRAINT_NAMES) {
        expect(names).toContain(expected);
      }
    } finally {
      await session.close();
    }
  });

  it("registers every expected index", async () => {
    const session = getDriver().session({ database: settings.neo4j.database });
    try {
      const result = await session.run<{ names: string[] }>(
        "SHOW INDEXES YIELD name RETURN collect(name) AS names",
      );
      const names = result.records[0]?.get("names") ?? [];
      for (const expected of EXPECTED_INDEX_NAMES) {
        expect(names).toContain(expected);
      }
    } finally {
      await session.close();
    }
  });
});
