/**
 * TypeScript representations of the CircuitLoop graph entities.
 *
 * These mirror the node/relationship design in `BACKEND_IMPLEMENTATION_PLAN.md`
 * §5 (Database Design — Neo4j Graph Model) exactly — that document is the
 * authoritative schema design; this file is its TypeScript expression, used
 * both by the schema bootstrap (`db/schema.ts`) and, in the next phase, by
 * the repository layer that reads/writes these shapes.
 */

// ---------------------------------------------------------------------------
// Node labels & relationship types (single source of truth for Cypher below)
// ---------------------------------------------------------------------------

export const NodeLabel = {
  User: "User",
  Scan: "Scan",
  Component: "Component",
  TestResult: "TestResult",
  Command: "Command",
  HealthReport: "HealthReport",
  MonitoringAgent: "MonitoringAgent",
  DatasheetChunk: "DatasheetChunk",
} as const;

export type NodeLabel = (typeof NodeLabel)[keyof typeof NodeLabel];

export const RelationshipType = {
  /** (:User)-[:OWNS]->(:Scan) */
  OWNS: "OWNS",
  /** (:Scan)-[:DETECTED]->(:Component) */
  DETECTED: "DETECTED",
  /** (:Component)-[:HAS_TEST_RESULT]->(:TestResult) */
  HAS_TEST_RESULT: "HAS_TEST_RESULT",
  /** (:Component)-[:HAS_COMMAND]->(:Command) */
  HAS_COMMAND: "HAS_COMMAND",
  /** (:MonitoringAgent)-[:REPORTED]->(:HealthReport) */
  REPORTED: "REPORTED",
} as const;

export type RelationshipType = (typeof RelationshipType)[keyof typeof RelationshipType];

// ---------------------------------------------------------------------------
// Domain value types
// ---------------------------------------------------------------------------

// Extended per ML_SERVICE_INTEGRATION_PLAN.md's YOLO class-list verification:
// the trained model's real classes (battery, buzzer, display, relay, switch)
// don't fit the original 8-value set, and the intent is a domain that covers
// every valid CircuitLoop component type — not just what one model detects.
// `led`/`diode`/`transistor`/`microcontroller` are kept for a future model;
// `unknown` stays reserved for genuinely unrecognized types, not as a
// catch-all for these five known, now-supported ones.
export type ComponentType =
  | "resistor"
  | "capacitor"
  | "led"
  | "diode"
  | "transistor"
  | "ic"
  | "microcontroller"
  | "battery"
  | "buzzer"
  | "display"
  | "relay"
  | "switch"
  | "unknown";

export type ComponentCondition = "good" | "damaged" | "uncertain" | "unknown";

export type SalvagePriority = "high" | "medium" | "low";

export type ComponentStatus = "not_tested" | "pass" | "fail";

export type CommandStatus = "pending" | "success" | "failure" | "timeout";

export type MonitoredComponentKey = "cpu" | "ram" | "disk" | "gpu" | "nic" | "other";

export type HealthStatus = "healthy" | "degraded" | "unresponsive" | "unknown";

// ---------------------------------------------------------------------------
// Node property shapes
// ---------------------------------------------------------------------------

/**
 * (:User) node properties.
 *
 * `passwordHash` is a bcrypt digest and must never leave the backend — see
 * `toUserResponse` in types/dto.ts, which is the only sanctioned way to send a
 * user to a client.
 */
export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string; // ISO 8601, converted from Neo4j's native datetime()
}

/** (:Scan) node properties. */
export interface Scan {
  id: string;
  imagePath: string | null;
  timestamp: string; // ISO 8601, converted from Neo4j's native datetime()
}

/** (:Component) node properties. */
export interface Component {
  id: string;
  type: ComponentType;
  /**
   * The detector's own name for this component, verbatim — `"network switch"`,
   * `"potentiometer"`, `"crystal"`, `"ic"`.
   *
   * `type` above is this label narrowed to the closed `ComponentType` union so
   * it stays queryable; that narrowing is lossy (`"network switch"` becomes
   * `"switch"`, `"potentiometer"` becomes `"unknown"`), and this field is where
   * the unnarrowed answer survives. It is the component's DISPLAY IDENTITY:
   * clients show `label ?? type`, never `name`.
   *
   * Null for components created by hand through the API without one, and for
   * every component detected before this field existed — hence `?? type`.
   *
   * Emphatically NOT the printed marking. What is written on the part lives in
   * `name`; confusing the two is the bug this field was added to end.
   */
  label: string | null;
  /**
   * The marking read off the component — a part number, brand, or printed
   * value (`"74HC83"`, `"CISCO SG300-52 …"`, `"220 16V"`), or null when the
   * part carries none.
   *
   * Evidence about the component, not its identity: a part is not a "CISCO",
   * it is a network switch that says CISCO on it. Never render this in place
   * of `label`/`type`.
   */
  name: string | null;
  confidence: number;
  condition: ComponentCondition;
  salvagePriority: SalvagePriority | null;
  x1: number | null;
  y1: number | null;
  x2: number | null;
  y2: number | null;
  status: ComponentStatus;
  createdAt: string; // ISO 8601
}

/** (:TestResult) node properties. */
export interface TestResult {
  id: string;
  expectedValue: number | null;
  measuredValue: number | null;
  unit: string | null;
  status: ComponentStatus;
  timestamp: string; // ISO 8601
}

/** (:Command) node properties — ESP32 gateway commands (Phase E/F). */
export interface Command {
  id: string;
  action: string;
  status: CommandStatus;
  sentAt: string; // ISO 8601
  resolvedAt: string | null;
  ackReceived: boolean;
  detail: string | null;
  /**
   * The component this command was aimed at, or `null` for a gateway-level
   * probe that isn't about any single part (the automatic heartbeat/ACK
   * probe is always `null`).
   *
   * Stored denormalized on the node in addition to the
   * `(:Component)-[:HAS_COMMAND]->(:Command)` edge, so the common
   * "commands for this component" and "gateway probes only" queries are a
   * single indexed property lookup rather than a traversal — see the
   * `command_component_id_index` in `db/schema.ts`.
   */
  componentId: string | null;
}

/** (:MonitoringAgent) node properties (Phase H). */
export interface MonitoringAgent {
  agentId: string;
  firstSeenAt: string; // ISO 8601
  lastSeenAt: string; // ISO 8601
}

/**
 * (:DatasheetChunk) node properties — the RAG corpus.
 *
 * Unlike every other node in this file, these are **not** user data: the
 * corpus is a global, read-only set of public vendor datasheet excerpts with
 * no owner and no `(:User)-[:OWNS]->` edge, shared by every user. Nothing in
 * this backend reads or writes these nodes; they are written offline by
 * `ml-service/pipeline/ingest.py` and read at query time by
 * `ml-service/search.py` through Neo4j's vector index. This interface exists
 * so the graph schema stays fully described in one place — see
 * `db/schema.ts`, which declares the constraint and indexes that back it.
 *
 * `embedding` is deliberately absent: it is a 384-float vector that no
 * TypeScript code path ever needs, and typing it here would invite loading
 * it into the API layer by accident.
 */
export interface DatasheetChunk {
  /** SHA-256 over (sourceFile, partName, section, text) — see ml-service/neo4j_store.py::content_id. */
  id: string;
  /** The ingestion pipeline's own `{part}_{section}_{n}` label. Provenance only — NOT unique, so never key on it. */
  chunkId: string;
  text: string;
  partName: string;
  section: string;
  sourceFile: string;
}

/** (:HealthReport) node properties (Phase H). */
export interface HealthReport {
  /** Synthetic key: `${agentId}:${componentKey}` — see BACKEND_IMPLEMENTATION_PLAN.md §5.2/§5.4. */
  id: string;
  agentId: string;
  componentKey: MonitoredComponentKey;
  status: HealthStatus;
  /** JSON-encoded free-form metric blob — see §5.1 on why this isn't a nested property. */
  metricsJson: string;
  cpuPercent: number | null;
  ramPercent: number | null;
  diskPercent: number | null;
  lastHeartbeatAt: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Repository read shapes (entity + relationship data attached)
//
// List endpoints return the lighter "summary" shape (no nested relations);
// get-by-id endpoints return the "detail" shape (relations attached) — this
// matches the list-vs-detail split already specified in
// BACKEND_IMPLEMENTATION_PLAN.md §5.7, deliberately lighter than the
// original SQL version's eager-load-everything-everywhere behavior.
// ---------------------------------------------------------------------------

/** A Component with its parent scan id and full test-result history attached. */
export interface ComponentDetail extends Component {
  scanId: string | null;
  testResults: TestResult[];
}

/** A Scan with its detected components (each with test-result history) attached. */
export interface ScanDetail extends Scan {
  totalComponents: number;
  components: ComponentDetail[];
}

/** A Scan with only its computed component count — used by the list endpoint. */
export interface ScanSummary extends Scan {
  totalComponents: number;
}

/** Aggregate counts/averages for GET /api/dashboard/stats. */
export interface DashboardStats {
  totalScans: number;
  totalComponents: number;
  testedComponents: number;
  passedComponents: number;
  failedComponents: number;
  notTestedComponents: number;
  averageAiConfidence: number | null;
}
