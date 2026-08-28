/**
 * Neo4j schema bootstrap: uniqueness constraints and indexes.
 *
 * Implements the constraint/index design from `BACKEND_IMPLEMENTATION_PLAN.md`
 * §5.4 verbatim — every statement is written to work on Neo4j **Community
 * Edition** (single-property uniqueness constraints and range indexes only;
 * no composite/`NODE KEY` constraints, which are Enterprise-only). Every
 * statement uses `IF NOT EXISTS`, so `ensureConstraintsAndIndexes` is safe
 * to call on every application startup — the same idempotent-bootstrap
 * convention the project's earlier SQLAlchemy `initialize_database()` used,
 * carried over to the graph model.
 *
 * `CREATE CONSTRAINT`/`CREATE INDEX` cannot run inside an explicit
 * transaction in Neo4j, so each statement is executed as its own
 * auto-commit `session.run(...)` call.
 */

import type { Driver } from "neo4j-driver";

import { NodeLabel } from "../types/entities.js";

interface SchemaStatement {
  readonly description: string;
  readonly cypher: string;
}

const CONSTRAINTS: readonly SchemaStatement[] = [
  {
    description: `Unique ${NodeLabel.User}.id`,
    cypher: `CREATE CONSTRAINT user_id_unique IF NOT EXISTS FOR (u:${NodeLabel.User}) REQUIRE u.id IS UNIQUE`,
  },
  {
    // Registration relies on this to reject duplicate accounts atomically,
    // rather than a read-then-write that two concurrent signups could both pass.
    description: `Unique ${NodeLabel.User}.email`,
    cypher: `CREATE CONSTRAINT user_email_unique IF NOT EXISTS FOR (u:${NodeLabel.User}) REQUIRE u.email IS UNIQUE`,
  },
  {
    description: `Unique ${NodeLabel.Scan}.id`,
    cypher: `CREATE CONSTRAINT scan_id_unique IF NOT EXISTS FOR (s:${NodeLabel.Scan}) REQUIRE s.id IS UNIQUE`,
  },
  {
    description: `Unique ${NodeLabel.Component}.id`,
    cypher: `CREATE CONSTRAINT component_id_unique IF NOT EXISTS FOR (c:${NodeLabel.Component}) REQUIRE c.id IS UNIQUE`,
  },
  {
    description: `Unique ${NodeLabel.TestResult}.id`,
    cypher: `CREATE CONSTRAINT testresult_id_unique IF NOT EXISTS FOR (t:${NodeLabel.TestResult}) REQUIRE t.id IS UNIQUE`,
  },
  {
    description: `Unique ${NodeLabel.Command}.id`,
    cypher: `CREATE CONSTRAINT command_id_unique IF NOT EXISTS FOR (cmd:${NodeLabel.Command}) REQUIRE cmd.id IS UNIQUE`,
  },
  {
    description: `Unique ${NodeLabel.HealthReport}.id`,
    cypher: `CREATE CONSTRAINT healthreport_id_unique IF NOT EXISTS FOR (h:${NodeLabel.HealthReport}) REQUIRE h.id IS UNIQUE`,
  },
  {
    description: `Unique ${NodeLabel.MonitoringAgent}.agentId`,
    cypher: `CREATE CONSTRAINT agent_id_unique IF NOT EXISTS FOR (a:${NodeLabel.MonitoringAgent}) REQUIRE a.agentId IS UNIQUE`,
  },
];

const INDEXES: readonly SchemaStatement[] = [
  {
    description: `Index ${NodeLabel.Component}.type`,
    cypher: `CREATE INDEX component_type_index IF NOT EXISTS FOR (c:${NodeLabel.Component}) ON (c.type)`,
  },
  {
    description: `Index ${NodeLabel.Component}.status`,
    cypher: `CREATE INDEX component_status_index IF NOT EXISTS FOR (c:${NodeLabel.Component}) ON (c.status)`,
  },
  {
    description: `Index ${NodeLabel.Component}.salvagePriority`,
    cypher: `CREATE INDEX component_salvage_priority_index IF NOT EXISTS FOR (c:${NodeLabel.Component}) ON (c.salvagePriority)`,
  },
  {
    description: `Index ${NodeLabel.Scan}.timestamp`,
    cypher: `CREATE INDEX scan_timestamp_index IF NOT EXISTS FOR (s:${NodeLabel.Scan}) ON (s.timestamp)`,
  },
  {
    description: `Index ${NodeLabel.Command}.status`,
    cypher: `CREATE INDEX command_status_index IF NOT EXISTS FOR (cmd:${NodeLabel.Command}) ON (cmd.status)`,
  },
  {
    description: `Index ${NodeLabel.HealthReport}.status`,
    cypher: `CREATE INDEX healthreport_status_index IF NOT EXISTS FOR (h:${NodeLabel.HealthReport}) ON (h.status)`,
  },
];

/** All schema statements, constraints first (each constraint implicitly backs an index on the same property, so ordering here doesn't matter functionally — constraints are simply listed first for readability). */
export const SCHEMA_STATEMENTS: readonly SchemaStatement[] = [...CONSTRAINTS, ...INDEXES];

/**
 * Creates every constraint and index the application depends on, if it
 * doesn't already exist. Called once at application startup, after
 * `initDriver()` succeeds and before the app is marked ready to serve
 * requests.
 */
export async function ensureConstraintsAndIndexes(
  driver: Driver,
  database: string | undefined,
): Promise<void> {
  const session = driver.session({ database });
  try {
    for (const statement of SCHEMA_STATEMENTS) {
      await session.run(statement.cypher);
    }
  } finally {
    await session.close();
  }
}
