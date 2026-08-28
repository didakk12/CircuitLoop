import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { settings } from "../src/config/env.js";
import { closeDriver, getDriver, initDriver } from "../src/db/neo4jDriver.js";
import { ensureConstraintsAndIndexes, ensureDataMigrations } from "../src/db/schema.js";

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

  describe("data migrations: component ownership backfill + orphan cleanup", () => {
    // Tagged ids so this test's fixtures are unambiguous even in the shared DB.
    const tag = `schema-mig-${randomUUID()}`;
    const userId = `${tag}-user`;
    const scanId = `${tag}-scan`;
    const scanLinkedA = `${tag}-scanlinked-a`;
    const scanLinkedB = `${tag}-scanlinked-b`;
    const pureOrphan = `${tag}-pure-orphan`;
    const orphanTestResult = `${tag}-orphan-tr`;

    afterAll(async () => {
      const session = getDriver().session({ database: settings.neo4j.database });
      try {
        await session.run(
          `MATCH (n) WHERE n.id STARTS WITH $tag
           OPTIONAL MATCH (n)-[:HAS_TEST_RESULT|HAS_COMMAND]->(child)
           DETACH DELETE n, child`,
          { tag },
        );
      } finally {
        await session.close();
      }
    });

    it("backfills OWNS from scan ownership, then deletes truly unowned components (and their sub-data), idempotently", async () => {
      const session = getDriver().session({ database: settings.neo4j.database });
      try {
        // A user with an owned scan whose DETECTED components lack the OWNS edge
        // (the pre-fix state), plus a pure orphan component with a test result.
        await session.run(
          `CREATE (u:User {id: $userId, email: $email, passwordHash: 'x', createdAt: datetime()})
           CREATE (u)-[:OWNS]->(s:Scan {id: $scanId, imagePath: null, timestamp: datetime()})
           CREATE (s)-[:DETECTED]->(a:Component {id: $scanLinkedA, type: 'resistor', name: null, confidence: 0.9,
             condition: 'unknown', salvagePriority: null, x1: null, y1: null, x2: null, y2: null,
             status: 'not_tested', createdAt: datetime()})
           CREATE (s)-[:DETECTED]->(b:Component {id: $scanLinkedB, type: 'capacitor', name: null, confidence: 0.8,
             condition: 'unknown', salvagePriority: null, x1: null, y1: null, x2: null, y2: null,
             status: 'not_tested', createdAt: datetime()})
           CREATE (o:Component {id: $pureOrphan, type: 'ic', name: null, confidence: 0.5,
             condition: 'unknown', salvagePriority: null, x1: null, y1: null, x2: null, y2: null,
             status: 'fail', createdAt: datetime()})
           CREATE (o)-[:HAS_TEST_RESULT]->(:TestResult {id: $orphanTestResult, expectedValue: 1, measuredValue: 0,
             unit: 'V', status: 'fail', timestamp: datetime()})`,
          { userId, email: `${tag}@example.test`, scanId, scanLinkedA, scanLinkedB, pureOrphan, orphanTestResult },
        );

        await ensureDataMigrations(getDriver(), settings.neo4j.database);

        const after = await session.run<{
          aOwner: string | null;
          bOwner: string | null;
          orphanCount: unknown;
          orphanTrCount: unknown;
          userCount: unknown;
          scanCount: unknown;
        }>(
          `OPTIONAL MATCH (ua:User)-[:OWNS]->(:Component {id: $scanLinkedA})
           OPTIONAL MATCH (ub:User)-[:OWNS]->(:Component {id: $scanLinkedB})
           RETURN ua.id AS aOwner, ub.id AS bOwner,
                  count { (:Component {id: $pureOrphan}) } AS orphanCount,
                  count { (:TestResult {id: $orphanTestResult}) } AS orphanTrCount,
                  count { (:User {id: $userId}) } AS userCount,
                  count { (:Scan {id: $scanId}) } AS scanCount`,
          { scanLinkedA, scanLinkedB, pureOrphan, orphanTestResult, userId, scanId },
        );
        const row = after.records[0]!;
        // Scan-linked components were attributed to their scan's owner.
        expect(row.get("aOwner")).toBe(userId);
        expect(row.get("bOwner")).toBe(userId);
        // The pure orphan and its test result were removed.
        expect(Number(row.get("orphanCount"))).toBe(0);
        expect(Number(row.get("orphanTrCount"))).toBe(0);
        // The user and scan are untouched.
        expect(Number(row.get("userCount"))).toBe(1);
        expect(Number(row.get("scanCount"))).toBe(1);

        // Idempotent: a second run changes nothing and does not throw.
        await expect(
          ensureDataMigrations(getDriver(), settings.neo4j.database),
        ).resolves.toBeUndefined();
        const stillOwned = await session.run<{ n: unknown }>(
          `MATCH (:User {id: $userId})-[:OWNS]->(c:Component) RETURN count(c) AS n`,
          { userId },
        );
        expect(Number(stillOwned.records[0]!.get("n"))).toBe(2);
      } finally {
        await session.close();
      }
    });
  });
});
