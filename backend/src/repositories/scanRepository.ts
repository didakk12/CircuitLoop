/**
 * Data access for (:Scan) nodes and their DETECTED relationship to
 * (:Component). Cypher here matches BACKEND_IMPLEMENTATION_PLAN.md §5.7
 * ("Scans" section) — see that document for the full rationale, including
 * why list/get-by-id return different levels of nesting (§5.7 comment on
 * the list query; entities.ts's `ScanSummary`/`ScanDetail` doc comments).
 */

import type { Node } from "neo4j-driver";

import { mapComponentNode, mapTestResultNode, mapScanNode } from "../db/mappers.js";
import { readQuery, writeQuery, type QueryRunner } from "../db/session.js";
import type { ScanDetail, ScanSummary } from "../types/entities.js";
import { newId } from "../utils/ids.js";

export interface CreateScanInput {
  imagePath: string | null;
  /** Owner of the scan. Every scan is created through an authenticated route, so this is always known. */
  ownerId: string;
}

export async function createScan(input: CreateScanInput, runner?: QueryRunner): Promise<ScanDetail> {
  return writeQuery(runner, async (r) => {
    const result = await r.run<{ s: Node }>(
      `MATCH (u:User {id: $ownerId})
       CREATE (u)-[:OWNS]->(s:Scan {id: $id, imagePath: $imagePath, timestamp: datetime()})
       RETURN s`,
      { id: newId(), imagePath: input.imagePath, ownerId: input.ownerId },
    );
    const record = result.records[0];
    if (!record) {
      throw new Error("Failed to create scan: no record returned");
    }
    return { ...mapScanNode(record.get("s")), totalComponents: 0, components: [] };
  });
}

/** Cheap existence check — used by componentService to validate a `scan_id` reference before create/update. */
export async function scanExists(id: string, runner?: QueryRunner): Promise<boolean> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ found: boolean }>("MATCH (s:Scan {id: $id}) RETURN true AS found", { id });
    return result.records.length > 0;
  });
}

/** A user's scan history, newest first. Scoped by ownership — never returns another user's scans. */
export async function listScans(ownerId: string, runner?: QueryRunner): Promise<ScanSummary[]> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ s: Node; totalComponents: number }>(
      `MATCH (:User {id: $ownerId})-[:OWNS]->(s:Scan)
       OPTIONAL MATCH (s)-[:DETECTED]->(c:Component)
       RETURN s, count(c) AS totalComponents
       ORDER BY s.timestamp DESC`,
      { ownerId },
    );
    return result.records.map((record) => ({
      ...mapScanNode(record.get("s")),
      totalComponents: Number(record.get("totalComponents")),
    }));
  });
}

interface ComponentEntry {
  component: Node;
  testResults: Node[];
}

/**
 * Fetches one scan, but only if `ownerId` owns it.
 *
 * Ownership is part of the MATCH rather than a check after the fact, so a scan
 * belonging to someone else is indistinguishable from one that does not exist
 * — the caller gets `null` either way and cannot probe for valid ids.
 */
export async function getScanById(id: string, ownerId: string, runner?: QueryRunner): Promise<ScanDetail | null> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ s: Node; componentEntries: ComponentEntry[]; totalComponents: number }>(
      `MATCH (:User {id: $ownerId})-[:OWNS]->(s:Scan {id: $id})
       OPTIONAL MATCH (s)-[:DETECTED]->(c:Component)
       OPTIONAL MATCH (c)-[:HAS_TEST_RESULT]->(t:TestResult)
       WITH s, c, collect(t) AS testResults
       WITH s, collect(CASE WHEN c IS NULL THEN NULL ELSE {component: c, testResults: testResults} END) AS componentEntries
       RETURN s, componentEntries, size(componentEntries) AS totalComponents`,
      { id, ownerId },
    );
    const record = result.records[0];
    if (!record) {
      return null;
    }
    const componentEntries = record.get("componentEntries");
    return {
      ...mapScanNode(record.get("s")),
      totalComponents: Number(record.get("totalComponents")),
      components: componentEntries.map((entry) => ({
        ...mapComponentNode(entry.component),
        scanId: id,
        testResults: entry.testResults.map(mapTestResultNode),
      })),
    };
  });
}

/** Sets the persisted image filename for a scan. Bare filename only — never a path. */
export async function setImagePath(id: string, imagePath: string, runner?: QueryRunner): Promise<void> {
  await writeQuery(runner, async (r) => {
    await r.run("MATCH (s:Scan {id: $id}) SET s.imagePath = $imagePath", { id, imagePath });
  });
}

/**
 * Returns the stored image filename for a scan the user owns, or `null` if the
 * scan does not exist, is not theirs, or has no image. Ownership is enforced in
 * the MATCH for the same reason as `getScanById`.
 */
export async function getOwnedImagePath(
  id: string,
  ownerId: string,
  runner?: QueryRunner,
): Promise<string | null> {
  return readQuery(runner, async (r) => {
    const result = await r.run<{ imagePath: string | null }>(
      `MATCH (:User {id: $ownerId})-[:OWNS]->(s:Scan {id: $id})
       RETURN s.imagePath AS imagePath`,
      { id, ownerId },
    );
    const record = result.records[0];
    return record ? (record.get("imagePath") as string | null) : null;
  });
}
