/**
 * Data access for (:Component) nodes: creation (single + detection batch),
 * retrieval, update, deletion, and their DETECTED relationship to the
 * parent (:Scan). Cypher matches BACKEND_IMPLEMENTATION_PLAN.md §5.7
 * ("Components" section).
 *
 * Every component is owned by exactly one user, expressed as
 * `(:User)-[:OWNS]->(:Component)` — the same ownership edge scans already
 * use. All reads and writes here are scoped to the authenticated user's
 * id: a component belonging to another user is indistinguishable from one
 * that does not exist. Components detected from a scan are additionally
 * owned by that scan's owner (created in the same statement).
 */

import type { Node } from "neo4j-driver";

import { mapComponentNode, mapTestResultNode } from "../db/mappers.js";
import { readQuery, writeQuery, type QueryRunner } from "../db/session.js";
import type {
  ComponentCondition,
  ComponentDetail,
  ComponentStatus,
  ComponentType,
  SalvagePriority,
} from "../types/entities.js";
import { newId } from "../utils/ids.js";

export interface ComponentInput {
  scanId: string | null;
  type: ComponentType;
  name: string | null;
  confidence: number;
  condition: ComponentCondition;
  salvagePriority: SalvagePriority | null;
  x1: number | null;
  y1: number | null;
  x2: number | null;
  y2: number | null;
}

export interface ComponentListFilters {
  type?: ComponentType;
  status?: ComponentStatus;
}

function toComponentDetail(node: Node, scanId: string | null, testResultNodes: Node[] = []): ComponentDetail {
  return {
    ...mapComponentNode(node),
    scanId,
    testResults: testResultNodes.map(mapTestResultNode),
  };
}

export async function createComponent(
  input: ComponentInput,
  ownerId: string,
  runner?: QueryRunner,
): Promise<ComponentDetail> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ c: Node }>(
      `MATCH (owner:User {id: $ownerId})
       CREATE (owner)-[:OWNS]->(c:Component {
         id: $id, type: $type, name: $name, confidence: $confidence,
         condition: $condition, salvagePriority: $salvagePriority,
         x1: $x1, y1: $y1, x2: $x2, y2: $y2,
         status: "not_tested", createdAt: datetime()
       })
       WITH c, owner
       OPTIONAL MATCH (owner)-[:OWNS]->(s:Scan {id: $scanId})
       FOREACH (ignoreMe IN CASE WHEN s IS NULL THEN [] ELSE [1] END | CREATE (s)-[:DETECTED]->(c))
       RETURN c`,
      { id: newId(), ownerId, ...input },
    );
    const record = result.records[0];
    if (!record) {
      throw new Error("Failed to create component: owner not found");
    }
    return toComponentDetail(record.get("c"), input.scanId);
  });
}

/**
 * Batch-creates components detected in one scan (POST /api/detections and
 * the scan-upload flow). Returns `null` if `scanId` doesn't reference a
 * scan owned by `ownerId` — the caller (service layer) turns that into a
 * `NotFoundError`. `inputs` is guaranteed non-empty by request validation
 * before this is called. Each created component is owned by the scan's
 * owner, so it is reachable by exactly the same user who owns the scan.
 */
export async function createDetectionBatch(
  scanId: string,
  inputs: ComponentInput[],
  ownerId: string,
  runner?: QueryRunner,
): Promise<ComponentDetail[] | null> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ c: Node }>(
      `MATCH (owner:User {id: $ownerId})-[:OWNS]->(s:Scan {id: $scanId})
       UNWIND $detections AS d
       CREATE (owner)-[:OWNS]->(c:Component {
         id: d.id, type: d.type, name: d.name, confidence: d.confidence,
         condition: d.condition, salvagePriority: d.salvagePriority,
         x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2,
         status: "not_tested", createdAt: datetime()
       })
       CREATE (s)-[:DETECTED]->(c)
       RETURN c`,
      {
        ownerId,
        scanId,
        detections: inputs.map((input) => ({ id: newId(), ...input })),
      },
    );
    if (result.records.length === 0) {
      return null;
    }
    return result.records.map((record) => toComponentDetail(record.get("c"), scanId));
  });
}

export async function listComponents(
  filters: ComponentListFilters,
  ownerId: string,
  runner?: QueryRunner,
): Promise<ComponentDetail[]> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ c: Node; scanId: string | null }>(
      `MATCH (:User {id: $ownerId})-[:OWNS]->(c:Component)
       WHERE ($type IS NULL OR c.type = $type) AND ($status IS NULL OR c.status = $status)
       OPTIONAL MATCH (s:Scan)-[:DETECTED]->(c)
       RETURN c, s.id AS scanId
       ORDER BY c.id`,
      { ownerId, type: filters.type ?? null, status: filters.status ?? null },
    );
    return result.records.map((record) => toComponentDetail(record.get("c"), record.get("scanId")));
  });
}

/**
 * Cheap ownership + existence check — used by testResultService to produce
 * the right 404 (component vs. test result). Returns `false` for a
 * component owned by someone else, exactly as if it did not exist.
 */
export async function componentExists(id: string, ownerId: string, runner?: QueryRunner): Promise<boolean> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ found: boolean }>(
      "MATCH (:User {id: $ownerId})-[:OWNS]->(c:Component {id: $id}) RETURN true AS found",
      { id, ownerId },
    );
    return result.records.length > 0;
  });
}

export async function getComponentById(
  id: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<ComponentDetail | null> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ c: Node; scanId: string | null; testResults: Node[] }>(
      // Test results come back oldest-first. `collect()` on its own guarantees
      // no ordering at all, so without this ORDER BY the history arrived in an
      // arbitrary order — which assistantService's test-history summary (and
      // hence "what was the most recent result?") depends on.
      //
      // Known limit, measured against this server: Neo4j's `datetime()` has
      // millisecond clock resolution (its nanosecond field is always a whole
      // number of milliseconds), so several results written within the same
      // millisecond carry an identical timestamp and have no recoverable
      // relative order. Ordering them would need a monotonic sequence on the
      // node, which is a schema change and not one this read path can make.
      // In practice test results are recorded by a human seconds apart.
      `MATCH (:User {id: $ownerId})-[:OWNS]->(c:Component {id: $id})
       OPTIONAL MATCH (s:Scan)-[:DETECTED]->(c)
       OPTIONAL MATCH (c)-[:HAS_TEST_RESULT]->(t:TestResult)
       WITH c, s, t ORDER BY t.timestamp ASC
       RETURN c, s.id AS scanId, collect(t) AS testResults`,
      { id, ownerId },
    );
    const record = result.records[0];
    if (!record) {
      return null;
    }
    return toComponentDetail(record.get("c"), record.get("scanId"), record.get("testResults"));
  });
}

export async function updateComponent(
  id: string,
  input: ComponentInput,
  ownerId: string,
  runner?: QueryRunner,
): Promise<ComponentDetail | null> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ c: Node; scanId: string | null; testResults: Node[] }>(
      `MATCH (owner:User {id: $ownerId})-[:OWNS]->(c:Component {id: $id})
       SET c.type = $type, c.name = $name, c.confidence = $confidence,
           c.condition = $condition, c.salvagePriority = $salvagePriority,
           c.x1 = $x1, c.y1 = $y1, c.x2 = $x2, c.y2 = $y2
       WITH c, owner
       OPTIONAL MATCH (:Scan)-[oldRel:DETECTED]->(c)
       DELETE oldRel
       WITH c, owner
       OPTIONAL MATCH (owner)-[:OWNS]->(newScan:Scan {id: $scanId})
       FOREACH (ignoreMe IN CASE WHEN newScan IS NULL THEN [] ELSE [1] END | CREATE (newScan)-[:DETECTED]->(c))
       WITH c
       OPTIONAL MATCH (c)-[:HAS_TEST_RESULT]->(t:TestResult)
       WITH c, t ORDER BY t.timestamp ASC
       RETURN c, $scanId AS scanId, collect(t) AS testResults`,
      { id, ownerId, ...input },
    );
    const record = result.records[0];
    if (!record) {
      return null;
    }
    return toComponentDetail(record.get("c"), record.get("scanId"), record.get("testResults"));
  });
}

export async function deleteComponent(id: string, ownerId: string, runner?: QueryRunner): Promise<boolean> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ deleted: boolean }>(
      `MATCH (:User {id: $ownerId})-[:OWNS]->(c:Component {id: $id})
       OPTIONAL MATCH (c)-[:HAS_TEST_RESULT]->(t:TestResult)
       OPTIONAL MATCH (c)-[:HAS_COMMAND]->(cmd:Command)
       WITH c, collect(t) AS testResults, collect(cmd) AS commands
       FOREACH (t IN testResults | DETACH DELETE t)
       FOREACH (cmd IN commands | DETACH DELETE cmd)
       DETACH DELETE c
       RETURN true AS deleted`,
      { id, ownerId },
    );
    return result.records.length > 0;
  });
}
