/**
 * Aggregate stats for GET /api/dashboard/stats. Cypher matches
 * BACKEND_IMPLEMENTATION_PLAN.md §5.7 ("Dashboard stats" section).
 *
 * Every count is scoped to the authenticated user's owned scans and
 * components (`(:User)-[:OWNS]->`), so the dashboard reflects only that
 * user's data — never a global total across all accounts.
 */

import { toNumber } from "../db/mappers.js";
import { readQuery, type QueryRunner } from "../db/session.js";
import type { DashboardStats } from "../types/entities.js";

// A `type` alias (not `interface`) so it structurally satisfies the
// `Record<string, unknown>` constraint on QueryRunner.run<R>() — TS only
// grants object-literal types an implicit index signature, not interfaces.
type StatsRow = {
  totalScans: number;
  totalComponents: number;
  averageAiConfidence: number | null;
  passedComponents: number;
  failedComponents: number;
  notTestedComponents: number;
  testedComponents: number;
};

export async function getStats(ownerId: string, runner?: QueryRunner): Promise<DashboardStats> {
  return readQuery(runner, async (r) => {
    const result = await r.run<StatsRow>(
      `CALL { MATCH (:User {id: $ownerId})-[:OWNS]->(s:Scan) RETURN count(s) AS totalScans }
       CALL {
         MATCH (:User {id: $ownerId})-[:OWNS]->(c:Component)
         RETURN count(c) AS totalComponents,
                avg(c.confidence) AS averageAiConfidence,
                sum(CASE WHEN c.status = 'pass' THEN 1 ELSE 0 END) AS passedComponents,
                sum(CASE WHEN c.status = 'fail' THEN 1 ELSE 0 END) AS failedComponents,
                sum(CASE WHEN c.status = 'not_tested' THEN 1 ELSE 0 END) AS notTestedComponents
       }
       RETURN totalScans, totalComponents, averageAiConfidence,
              passedComponents, failedComponents, notTestedComponents,
              (passedComponents + failedComponents) AS testedComponents`,
      { ownerId },
    );
    const record = result.records[0];
    if (!record) {
      // Empty graph: every count is legitimately zero.
      return {
        totalScans: 0,
        totalComponents: 0,
        testedComponents: 0,
        passedComponents: 0,
        failedComponents: 0,
        notTestedComponents: 0,
        averageAiConfidence: null,
      };
    }
    return {
      totalScans: toNumber(record.get("totalScans")),
      totalComponents: toNumber(record.get("totalComponents")),
      testedComponents: toNumber(record.get("testedComponents")),
      passedComponents: toNumber(record.get("passedComponents")),
      failedComponents: toNumber(record.get("failedComponents")),
      notTestedComponents: toNumber(record.get("notTestedComponents")),
      averageAiConfidence:
        record.get("averageAiConfidence") === null ? null : toNumber(record.get("averageAiConfidence")),
    };
  });
}
