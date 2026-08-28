/**
 * Wire-format DTOs (request/response JSON shapes) and their mapping
 * functions to/from the domain entities in `entities.ts`.
 *
 * Field names are `snake_case` and deliberately mirror the *existing*
 * project API contract (the original Python `schemas.py` / the frontend's
 * `origin/rag-integration:frontend/src/api.ts`) so nothing downstream that
 * already expects this shape has to change — see
 * BACKEND_IMPLEMENTATION_PLAN.md §3. The one necessary deviation: every id
 * is `string` (a Neo4j UUID), not `number` (the old SQL autoincrement id) —
 * recorded there as a justified, necessary change.
 */

import type {
  ComponentCondition,
  ComponentDetail,
  ComponentStatus,
  ComponentType,
  DashboardStats,
  SalvagePriority,
  ScanDetail,
  ScanSummary,
  TestResult,
  User,
} from "./entities.js";

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

export interface CreateScanRequest {
  image_path?: string | null;
}

export interface CreateComponentRequest {
  scan_id?: string | null;
  type: ComponentType;
  name?: string | null;
  confidence: number;
  condition?: ComponentCondition;
  salvage_priority?: SalvagePriority | null;
  x1?: number | null;
  y1?: number | null;
  x2?: number | null;
  y2?: number | null;
}

/** PUT /api/components/:id uses the same full-replace shape as create, per the original contract. */
export type UpdateComponentRequest = CreateComponentRequest;

export interface DetectionBoundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DetectionCreateRequest {
  type: ComponentType;
  name?: string | null;
  confidence: number;
  bbox: DetectionBoundingBox;
}

export interface DetectionBatchCreateRequest {
  scan_id: string;
  detections: DetectionCreateRequest[];
}

export interface CreateTestResultRequest {
  expected_value?: number | null;
  measured_value?: number | null;
  unit?: string | null;
  status: ComponentStatus;
}

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

export interface TestResultResponse {
  id: string;
  component_id: string;
  expected_value: number | null;
  measured_value: number | null;
  unit: string | null;
  status: ComponentStatus;
  timestamp: string;
}

export interface ComponentResponse {
  id: string;
  scan_id: string | null;
  type: ComponentType;
  name: string | null;
  confidence: number;
  condition: ComponentCondition;
  salvage_priority: SalvagePriority | null;
  x1: number | null;
  y1: number | null;
  x2: number | null;
  y2: number | null;
  status: ComponentStatus;
  created_at: string;
  test_results: TestResultResponse[];
}

export interface ScanResponse {
  id: string;
  /**
   * URL of this scan's uploaded image, or `null` if none was stored.
   *
   * Deliberately a URL onto the ownership-checked `/api/scans/:id/image`
   * endpoint rather than the stored filename: the client never learns anything
   * about how or where images are stored on disk.
   */
  image_url: string | null;
  timestamp: string;
  total_components: number;
  components: ComponentResponse[];
}

export interface DashboardStatsResponse {
  total_scans: number;
  total_components: number;
  tested_components: number;
  passed_components: number;
  failed_components: number;
  not_tested_components: number;
  average_ai_confidence: number | null;
}

// ---------------------------------------------------------------------------
// Assistant (Phase 6) — shape matches the contract already established in
// CIRCUIT_LOOP_PLAN.md / BACKEND_IMPLEMENTATION_PLAN.md's original design
// (component_id, configured, message), with component_id as a string to
// match this project's UUID convention.
// ---------------------------------------------------------------------------

export interface AssistantRequest {
  component_id: string;
  question: string;
}

export interface AssistantResponse {
  component_id: string;
  /** True only once a real LLM generation call actually ran — see services/llmProvider.ts. */
  configured: boolean;
  message: string;
}

/**
 * One Server-Sent Event frame from `POST /api/assistant/stream` (the
 * streaming counterpart of `POST /api/assistant`). Each frame is sent as
 * `data: <JSON>\n\n`.
 *
 * - `delta`  — append `text` to the answer being streamed.
 * - `done`   — the answer finished normally; `configured` mirrors
 *              `AssistantResponse.configured`.
 * - `unavailable` — no provider is configured, or the provider failed:
 *   `text` is the generic message and it *replaces* anything streamed so
 *   far (same guarantee as the non-streaming endpoint — no partial or
 *   component-derived content leaks out of a failed generation).
 */
export type AssistantStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; configured: true }
  | { type: "unavailable"; text: string };

// ---------------------------------------------------------------------------
// Entity → response DTO mapping
// ---------------------------------------------------------------------------

export function toTestResultResponse(entity: TestResult, componentId: string): TestResultResponse {
  return {
    id: entity.id,
    component_id: componentId,
    expected_value: entity.expectedValue,
    measured_value: entity.measuredValue,
    unit: entity.unit,
    status: entity.status,
    timestamp: entity.timestamp,
  };
}

export function toComponentResponse(detail: ComponentDetail): ComponentResponse {
  return {
    id: detail.id,
    scan_id: detail.scanId,
    type: detail.type,
    name: detail.name,
    confidence: detail.confidence,
    condition: detail.condition,
    salvage_priority: detail.salvagePriority,
    x1: detail.x1,
    y1: detail.y1,
    x2: detail.x2,
    y2: detail.y2,
    status: detail.status,
    created_at: detail.createdAt,
    test_results: detail.testResults.map((testResult) => toTestResultResponse(testResult, detail.id)),
  };
}

function toImageUrl(scanId: string, imagePath: string | null): string | null {
  return imagePath === null ? null : `/api/scans/${scanId}/image`;
}

/** For the list endpoint — no nested components (see entities.ts's `ScanSummary` doc comment). */
export function toScanSummaryResponse(summary: ScanSummary): ScanResponse {
  return {
    id: summary.id,
    image_url: toImageUrl(summary.id, summary.imagePath),
    timestamp: summary.timestamp,
    total_components: summary.totalComponents,
    components: [],
  };
}

/** For the get-by-id endpoint — full nested components + their test results. */
export function toScanDetailResponse(detail: ScanDetail): ScanResponse {
  return {
    id: detail.id,
    image_url: toImageUrl(detail.id, detail.imagePath),
    timestamp: detail.timestamp,
    total_components: detail.totalComponents,
    components: detail.components.map(toComponentResponse),
  };
}

export function toDashboardStatsResponse(stats: DashboardStats): DashboardStatsResponse {
  return {
    total_scans: stats.totalScans,
    total_components: stats.totalComponents,
    tested_components: stats.testedComponents,
    passed_components: stats.passedComponents,
    failed_components: stats.failedComponents,
    not_tested_components: stats.notTestedComponents,
    average_ai_confidence: stats.averageAiConfidence,
  };
}

// ---------------------------------------------------------------------------
// Request DTO → repository input mapping helpers
// ---------------------------------------------------------------------------

export interface CreateComponentInput {
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

export function fromCreateComponentRequest(body: CreateComponentRequest): CreateComponentInput {
  return {
    scanId: body.scan_id ?? null,
    type: body.type,
    name: body.name ?? null,
    confidence: body.confidence,
    condition: body.condition ?? "unknown",
    salvagePriority: body.salvage_priority ?? null,
    x1: body.x1 ?? null,
    y1: body.y1 ?? null,
    x2: body.x2 ?? null,
    y2: body.y2 ?? null,
  };
}

export interface CreateTestResultInput {
  expectedValue: number | null;
  measuredValue: number | null;
  unit: string | null;
  status: ComponentStatus;
}

export function fromCreateTestResultRequest(body: CreateTestResultRequest): CreateTestResultInput {
  return {
    expectedValue: body.expected_value ?? null,
    measuredValue: body.measured_value ?? null,
    unit: body.unit ?? null,
    status: body.status,
  };
}

/** Also used to convert a single DetectionCreateRequest → CreateComponentInput. */
export function fromDetectionCreateRequest(
  detection: DetectionCreateRequest,
  scanId: string,
): CreateComponentInput {
  return {
    scanId,
    type: detection.type,
    name: detection.name ?? null,
    confidence: detection.confidence,
    condition: "unknown",
    salvagePriority: null,
    x1: detection.bbox.x1,
    y1: detection.bbox.y1,
    x2: detection.bbox.x2,
    y2: detection.bbox.y2,
  };
}

/**
 * A user, as sent to a client.
 *
 * The only sanctioned way to serialise a `User` — `passwordHash` exists on the
 * entity and must never cross this boundary, so nothing here spreads the whole
 * object.
 */
export interface UserResponse {
  id: string;
  email: string;
  created_at: string;
}

export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    email: user.email,
    created_at: user.createdAt,
  };
}
