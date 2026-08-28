/**
 * Conversion between raw Neo4j driver values/nodes and the typed domain
 * entities in `types/entities.ts`.
 *
 * The Neo4j JS driver returns 64-bit Cypher integers as `neo4j.Integer`
 * objects (not plain `number`, since JS numbers can't safely represent the
 * full range) and temporal values (`datetime()`) as `neo4j.types.DateTime`
 * objects, not native `Date`/`string`. Every value that leaves this module
 * is a plain, JSON-serializable JS primitive — controllers and the
 * frontend never see a raw Neo4j driver type.
 */

import neo4j, { type Node } from "neo4j-driver";

import type {
  Component,
  ComponentCondition,
  ComponentStatus,
  ComponentType,
  SalvagePriority,
  Scan,
  User,
  TestResult,
} from "../types/entities.js";

/** Converts a Neo4j Integer (or plain number, for values that were never wrapped) to a safe JS number. */
export function toNumber(value: unknown): number {
  if (neo4j.isInt(value)) {
    return value.toNumber();
  }
  if (typeof value === "number") {
    return value;
  }
  throw new TypeError(`Expected a Neo4j Integer or number, got ${typeof value}: ${String(value)}`);
}

/** Same as {@link toNumber}, but passes through `null`/`undefined`. */
export function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

/** Converts a Neo4j temporal value (from `datetime()`) to an ISO 8601 string. */
export function toIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toStandardDate" in value &&
    typeof (value as { toStandardDate: unknown }).toStandardDate === "function"
  ) {
    return (value as { toStandardDate: () => Date }).toStandardDate().toISOString();
  }
  throw new TypeError(`Expected a Neo4j temporal value, got ${typeof value}: ${String(value)}`);
}

/** Same as {@link toIsoString}, but passes through `null`/`undefined`. */
export function toNullableIsoString(value: unknown): string | null {
  return value === null || value === undefined ? null : toIsoString(value);
}

function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function mapUserNode(node: Node): User {
  const p = node.properties;
  return {
    id: String(p["id"]),
    email: String(p["email"]),
    passwordHash: String(p["passwordHash"]),
    createdAt: toIsoString(p["createdAt"]),
  };
}

export function mapScanNode(node: Node): Scan {
  const p = node.properties;
  return {
    id: String(p["id"]),
    imagePath: toNullableString(p["imagePath"]),
    timestamp: toIsoString(p["timestamp"]),
  };
}

export function mapComponentNode(node: Node): Component {
  const p = node.properties;
  return {
    id: String(p["id"]),
    type: p["type"] as ComponentType,
    name: toNullableString(p["name"]),
    confidence: toNumber(p["confidence"]),
    condition: p["condition"] as ComponentCondition,
    salvagePriority: (p["salvagePriority"] as SalvagePriority | null) ?? null,
    x1: toNullableNumber(p["x1"]),
    y1: toNullableNumber(p["y1"]),
    x2: toNullableNumber(p["x2"]),
    y2: toNullableNumber(p["y2"]),
    status: p["status"] as ComponentStatus,
    createdAt: toIsoString(p["createdAt"]),
  };
}

export function mapTestResultNode(node: Node): TestResult {
  const p = node.properties;
  return {
    id: String(p["id"]),
    expectedValue: toNullableNumber(p["expectedValue"]),
    measuredValue: toNullableNumber(p["measuredValue"]),
    unit: toNullableString(p["unit"]),
    status: p["status"] as ComponentStatus,
    timestamp: toIsoString(p["timestamp"]),
  };
}
