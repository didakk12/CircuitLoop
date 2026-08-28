/**
 * Data access for (:TestResult) nodes and their HAS_TEST_RESULT
 * relationship from (:Component). Cypher matches
 * BACKEND_IMPLEMENTATION_PLAN.md §5.7 ("Test results" section). Creating a
 * result also updates the parent component's `status` in the same
 * statement, mirroring the original SQL model's behavior.
 *
 * Every function is scoped to the authenticated user: the parent component
 * must be one the user owns (`(:User)-[:OWNS]->(:Component)`), so a user
 * can never read or write test results on another user's component.
 */

import type { Node } from "neo4j-driver";

import { mapTestResultNode } from "../db/mappers.js";
import { readQuery, writeQuery, type QueryRunner } from "../db/session.js";
import type { ComponentStatus, TestResult } from "../types/entities.js";
import { newId } from "../utils/ids.js";

export interface TestResultInput {
  expectedValue: number | null;
  measuredValue: number | null;
  unit: string | null;
  status: ComponentStatus;
}

/** Returns `null` if `componentId` doesn't reference a component owned by `ownerId`. */
export async function createTestResult(
  componentId: string,
  input: TestResultInput,
  ownerId: string,
  runner?: QueryRunner,
): Promise<TestResult | null> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ t: Node }>(
      `MATCH (:User {id: $ownerId})-[:OWNS]->(c:Component {id: $componentId})
       CREATE (t:TestResult {
         id: $id, expectedValue: $expectedValue, measuredValue: $measuredValue,
         unit: $unit, status: $status, timestamp: datetime()
       })
       CREATE (c)-[:HAS_TEST_RESULT]->(t)
       SET c.status = $status
       RETURN t`,
      { id: newId(), componentId, ownerId, ...input },
    );
    const record = result.records[0];
    return record ? mapTestResultNode(record.get("t")) : null;
  });
}

/**
 * Latest result for a component the user owns, or `null` if it has none.
 * Callers must separately confirm the component itself exists and is owned
 * (`componentRepository.componentExists`) to distinguish "component not
 * found / not yours" from "component has no test results yet" — this query
 * alone can't tell the two apart.
 */
export async function getLatestTestResult(
  componentId: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<TestResult | null> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ t: Node }>(
      `MATCH (:User {id: $ownerId})-[:OWNS]->(:Component {id: $componentId})-[:HAS_TEST_RESULT]->(t:TestResult)
       RETURN t
       ORDER BY t.timestamp DESC
       LIMIT 1`,
      { componentId, ownerId },
    );
    const record = result.records[0];
    return record ? mapTestResultNode(record.get("t")) : null;
  });
}

/** Full test history for a component the user owns, oldest first. Empty array if the component exists but has no tests. */
export async function getTestHistory(
  componentId: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<TestResult[]> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ t: Node }>(
      `MATCH (:User {id: $ownerId})-[:OWNS]->(:Component {id: $componentId})-[:HAS_TEST_RESULT]->(t:TestResult)
       RETURN t
       ORDER BY t.timestamp ASC`,
      { componentId, ownerId },
    );
    return result.records.map((record) => mapTestResultNode(record.get("t")));
  });
}
