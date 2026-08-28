"""
Pydantic request/response models for the ML service's HTTP contract.
Mirrors `backend/src/types/mlService.ts` (§9 Phase 3) field-for-field, per
ML_SERVICE_INTEGRATION_PLAN.md §5. Kept manually in sync, same pattern
already used for the TS backend's `dto.ts`/Zod schemas.

Deliberately: `class_name` is the raw YOLO label, not a `ComponentType` —
mapping that is the TypeScript backend's job (§2/§5), not this service's.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class BoundingBoxModel(BaseModel):
    x1: int
    y1: int
    x2: int
    y2: int


class DetectionModel(BaseModel):
    class_name: str
    confidence: float
    bbox: BoundingBoxModel
    text: str


class DetectResponse(BaseModel):
    detections: list[DetectionModel]


class ModelDetectionsModel(BaseModel):
    """One model's complete, unmodified detection list.

    Deliberately kept as a separate list per model rather than a single merged
    array: nothing is deduplicated, suppressed, or ensembled at this stage, so
    both detectors' raw output stays independently inspectable for evaluation.
    """

    source: str  # stable model identifier, e.g. "circuitloop_yolo11s" / "hf_yolov8s"
    model_path: str
    class_count: int
    detections: list[DetectionModel]


class CompareResponse(BaseModel):
    """Side-by-side output of every loaded detector for one image.

    Benchmarking only — `/detect` is unchanged and still serves the original
    model alone, so nothing downstream is affected by this endpoint.
    """

    models: list[ModelDetectionsModel]


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=3, ge=1, le=20)


class SearchResultModel(BaseModel):
    part_name: str
    section: str
    source_file: str
    text: str


class SearchResponse(BaseModel):
    results: list[SearchResultModel]


class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    index_loaded: bool


class ErrorResponse(BaseModel):
    """Matches ML_SERVICE_INTEGRATION_PLAN.md §5's error shape — the TS
    client (Phase 3) translates this into its own {"detail": ...} envelope."""

    error: str
    detail: str | None = None
