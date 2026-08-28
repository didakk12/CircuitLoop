/**
 * TypeScript mirror of `ml-service/schemas.py`, per
 * ML_SERVICE_INTEGRATION_PLAN.md §5. Kept manually in sync with the Python
 * side, the same pattern already used between `schemas.py` and `dto.ts`
 * for the main API.
 *
 * `class_name` is deliberately the raw label the model produced — not the
 * domain `ComponentType`. Mapping one to the other is the caller's job
 * (Phase 4's detectionService, not built yet), not this type's.
 */

export interface MlBoundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MlDetection {
  class_name: string;
  confidence: number;
  bbox: MlBoundingBox;
  text: string;
}

export interface MlDetectResponse {
  detections: MlDetection[];
}

export interface MlSearchResult {
  part_name: string;
  section: string;
  source_file: string;
  text: string;
}

export interface MlSearchResponse {
  results: MlSearchResult[];
}

export interface MlHealthResponse {
  status: string;
  model_loaded: boolean;
  index_loaded: boolean;
}

/** Matches ml-service's ErrorResponse — what it sends back on a 4xx/5xx of its own. */
export interface MlErrorResponse {
  error: string;
  detail?: string | null;
}
