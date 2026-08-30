/**
 * Neo4j schema bootstrap: uniqueness constraints and indexes.
 *
 * Implements the constraint/index design from `BACKEND_IMPLEMENTATION_PLAN.md`
 * §5.4 verbatim — every statement is written to work on Neo4j **Community
 * Edition** (single-property uniqueness constraints and range indexes only;
 * no composite/`NODE KEY` constraints, which are Enterprise-only). The
 * `DatasheetChunk` vector index added for RAG keeps that property: vector
 * indexes are available in Community Edition too (since 5.11). Every
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
  {
    // The RAG corpus id is content-addressed (SHA-256 of the chunk's own
    // fields), which is what makes re-running ingestion idempotent — this
    // constraint is the database-level guarantee behind that.
    description: `Unique ${NodeLabel.DatasheetChunk}.id`,
    cypher: `CREATE CONSTRAINT datasheetchunk_id_unique IF NOT EXISTS FOR (d:${NodeLabel.DatasheetChunk}) REQUIRE d.id IS UNIQUE`,
  },
  {
    description: `Unique ${NodeLabel.MarketplaceListing}.id`,
    cypher: `CREATE CONSTRAINT marketplacelisting_id_unique IF NOT EXISTS FOR (m:${NodeLabel.MarketplaceListing}) REQUIRE m.id IS UNIQUE`,
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
    // Backs both halves of the hardware-ACK read path: "every command for
    // this component" and "gateway-level probes only" (`componentId IS
    // NULL`), neither of which the status index above can serve.
    description: `Index ${NodeLabel.Command}.componentId`,
    cypher: `CREATE INDEX command_component_id_index IF NOT EXISTS FOR (cmd:${NodeLabel.Command}) ON (cmd.componentId)`,
  },
  {
    description: `Index ${NodeLabel.HealthReport}.status`,
    cypher: `CREATE INDEX healthreport_status_index IF NOT EXISTS FOR (h:${NodeLabel.HealthReport}) ON (h.status)`,
  },
  {
    description: `Index ${NodeLabel.DatasheetChunk}.sourceFile`,
    cypher: `CREATE INDEX datasheetchunk_source_file_index IF NOT EXISTS FOR (d:${NodeLabel.DatasheetChunk}) ON (d.sourceFile)`,
  },
  {
    // Backs the duplicate-draft check, which filters a component's listings by
    // status on every POST /api/marketplace/listings.
    description: `Index ${NodeLabel.MarketplaceListing}.status`,
    cypher: `CREATE INDEX marketplacelisting_status_index IF NOT EXISTS FOR (m:${NodeLabel.MarketplaceListing}) ON (m.status)`,
  },
  {
    // `componentId` is denormalised onto the listing (see entities.ts), and
    // GET /api/marketplace/listings?component_id=X filters on it directly.
    description: `Index ${NodeLabel.MarketplaceListing}.componentId`,
    cypher: `CREATE INDEX marketplacelisting_component_id_index IF NOT EXISTS FOR (m:${NodeLabel.MarketplaceListing}) ON (m.componentId)`,
  },
  {
    // Vector index backing RAG retrieval. Neo4j replaced FAISS as the RAG
    // store and similarity-search layer, so this index is what
    // `ml-service/search.py` queries through `db.index.vector.queryNodes`.
    //
    // Declared here as well as in `ml-service/neo4j_store.py` so the graph
    // schema stays fully described in this one canonical file. Both use
    // `IF NOT EXISTS`, so whichever process starts first wins harmlessly —
    // and because "wins harmlessly" would stop being true if the two ever
    // specified different values, the Python side re-reads the live index
    // after creating it and refuses to start on a mismatch
    // (`RagStore.ensure_schema`). Keep these two declarations in sync.
    //
    // 384 = all-MiniLM-L6-v2's output width. Cosine because the stored and
    // query vectors are both L2-normalized, which makes it rank identically
    // to the euclidean distance the old FAISS IndexFlatL2 used while giving
    // a bounded [0,1] score the API can report.
    description: `Vector index ${NodeLabel.DatasheetChunk}.embedding`,
    cypher: `CREATE VECTOR INDEX datasheet_chunk_embedding_index IF NOT EXISTS
             FOR (d:${NodeLabel.DatasheetChunk}) ON (d.embedding)
             OPTIONS { indexConfig: { \`vector.dimensions\`: 384, \`vector.similarity_function\`: 'cosine' } }`,
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

/**
 * Idempotent data migrations run once at startup, right after the schema is
 * ensured, in order. Unlike the constraint/index block these are ordinary
 * writes, so each is a MERGE / guarded MATCH / owner-guarded DELETE that is
 * safe to re-run on every boot.
 */
const DATA_MIGRATIONS: readonly SchemaStatement[] = [
  {
    // Step 1 — Backfill. Component ownership was retrofitted after some
    // components already existed with only a `(:Scan)-[:DETECTED]->` link
    // and no direct `(:User)-[:OWNS]->(:Component)` edge. Give every
    // component that IS reachable from a user through their owned scan the
    // correct ownership edge, so it stays visible to — and only to — that
    // user. Idempotent: `WHERE NOT (u)-[:OWNS]->(c)` + MERGE.
    description: "Backfill (:User)-[:OWNS]->(:Component) from scan ownership",
    cypher: `MATCH (u:User)-[:OWNS]->(:Scan)-[:DETECTED]->(c:Component)
             WHERE NOT (u)-[:OWNS]->(c)
             MERGE (u)-[:OWNS]->(c)`,
  },
  {
    // Step 2 — Delete the true orphans. After step 1, any component with no
    // `(:User)-[:OWNS]->` edge cannot be attributed to any user (it was
    // created through the old unauthenticated path with no scan, or under a
    // scan nobody owns). It is unreachable through every API route, which
    // are all owner-scoped now. Remove it along with its own test
    // results / commands (each belongs to exactly one component, so nothing
    // user-owned is touched). Users and scans are never deleted here — only
    // the orphan Component nodes and the TestResult/Command nodes hanging
    // off them. Idempotent: once run, no unowned component matches.
    description: "Delete orphan (unowned) components and their test results / commands",
    cypher: `MATCH (c:Component)
             WHERE NOT ( (:User)-[:OWNS]->(c) )
             OPTIONAL MATCH (c)-[:HAS_TEST_RESULT]->(t:TestResult)
             OPTIONAL MATCH (c)-[:HAS_COMMAND]->(cmd:Command)
             DETACH DELETE c, t, cmd`,
  },
];

/**
 * Runs the idempotent data migrations above. Called once at startup after
 * `ensureConstraintsAndIndexes`.
 */
export async function ensureDataMigrations(driver: Driver, database: string | undefined): Promise<void> {
  const session = driver.session({ database });
  try {
    for (const migration of DATA_MIGRATIONS) {
      await session.run(migration.cypher);
    }
  } finally {
    await session.close();
  }
}
