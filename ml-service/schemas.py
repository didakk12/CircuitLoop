"""
Pydantic request/response models for the ML service's HTTP contract.
Mirrors `backend/src/types/mlService.ts` (§9 Phase 3) field-for-field, per
ML_SERVICE_INTEGRATION_PLAN.md §5. Kept manually in sync, same pattern
already used for the TS backend's `dto.ts`/Zod schemas.

Deliberately: `class_name` is the raw detector label, not a `ComponentType` —
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
    # Which stage served this response — always "gemini" now that Gemini is
    # the only detector. Optional and additive, so the TS client's
    # non-strict Zod schema accepts responses with or without it; nothing
    # branches on it.
    source: str | None = None


class SearchRequest(BaseModel):
    query: str = Field(min_length=1)
    top_k: int = Field(default=3, ge=1, le=20)
    # Minimum cosine similarity a chunk must reach to be returned. Optional:
    # when omitted the service applies its own calibrated default
    # (neo4j_store.DEFAULT_MIN_SCORE). The TypeScript backend always sends an
    # explicit value from CIRCUITLOOP_RAG_MIN_SCORE, so the effective
    # production threshold is configured in one place, backend-side.
    min_score: float | None = Field(default=None, ge=0.0, le=1.0)


class SearchResultModel(BaseModel):
    part_name: str
    section: str
    source_file: str
    text: str
    # Cosine similarity in [0, 1] straight from Neo4j's vector index. Added
    # with the Neo4j migration: the previous FAISS path discarded its
    # distance array, so a caller could not distinguish a strong hit from a
    # weak one. Bounded because the corpus and query vectors are both
    # L2-normalized (see neo4j_store.SIMILARITY_FUNCTION).
    score: float = Field(ge=0.0, le=1.0)


class SearchResponse(BaseModel):
    results: list[SearchResultModel]


class HealthResponse(BaseModel):
    status: str
    # True when Gemini — the only detector — can serve a request. Kept as its
    # own field (mirroring gemini_configured) since the TS client's schema
    # requires it.
    model_loaded: bool
    # Additive and defaulted, so the TS client's existing non-strict schema
    # is unaffected.
    gemini_configured: bool = False
    # True when the embedding model is loaded AND the Neo4j vector index is
    # reachable and ONLINE. The field name predates the Neo4j migration and is
    # kept so the TS client's contract is unchanged; only what backs it moved.
    index_loaded: bool


class ErrorResponse(BaseModel):
    """Matches ML_SERVICE_INTEGRATION_PLAN.md §5's error shape — the TS
    client (Phase 3) translates this into its own {"detail": ...} envelope."""

    error: str
    detail: str | None = None
