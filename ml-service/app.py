"""
CircuitLoop ML service — FastAPI app implementing the internal contract
from ML_SERVICE_INTEGRATION_PLAN.md §5: GET /health, POST /detect,
POST /search. Internal-only (see config.py — binds to 127.0.0.1 by
default); the TypeScript backend is the only intended caller (Phase 3/4,
not built yet).

Scope discipline, per the plan: this service does YOLO detection, OCR, and
embeddings/vector retrieval only. It does not decide what a detection
*means* for the product (no ComponentType mapping) — it returns exactly
what the model said and lets the TS backend interpret it.

Neo4j: as of the RAG migration this service does talk to Neo4j, but only
for the datasheet corpus — `(:DatasheetChunk)` nodes and their vector
index, which replaced the former FAISS index + metadata.json pair. It never
touches User/Scan/Component/TestResult data; those remain exclusively the
TS backend's, per ML_SERVICE_INTEGRATION_PLAN.md §7. See neo4j_store.py's
module docstring for the full rationale.
"""

from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.datastructures import State

from config import MISSING_NEO4J_MESSAGE, load_neo4j_settings, settings
from detection import (
    HF_MODEL_PATH,
    SOURCE_HF,
    DetectionService,
    ModelNotLoadedError,
)
from neo4j_store import RagStore
from schemas import (
    CompareResponse,
    DetectionModel,
    DetectResponse,
    ErrorResponse,
    HealthResponse,
    ModelDetectionsModel,
    SearchRequest,
    SearchResponse,
    SearchResultModel,
)
from search import SearchService, SearchServiceNotLoadedError

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ml-service")

ALLOWED_IMAGE_CONTENT_TYPES = {"image/png", "image/jpeg", "image/jpg"}


class MlServiceError(Exception):
    """Base for this service's own HTTP-shaped errors — mirrors the TS
    backend's AppError/errorHandler pattern (utils/errors.ts,
    middleware/errorHandler.ts) so both services fail in a consistent,
    structured way."""

    def __init__(self, status_code: int, error: str, detail: str | None = None) -> None:
        super().__init__(detail or error)
        self.status_code = status_code
        self.error = error
        self.detail = detail


class UnsupportedMediaTypeError(MlServiceError):
    def __init__(self, detail: str) -> None:
        super().__init__(415, "unsupported_media_type", detail)


class PayloadTooLargeError(MlServiceError):
    def __init__(self, detail: str) -> None:
        super().__init__(413, "payload_too_large", detail)


class InvalidImageError(MlServiceError):
    def __init__(self, detail: str) -> None:
        super().__init__(400, "invalid_image", detail)


class ServiceNotReadyError(MlServiceError):
    def __init__(self, detail: str) -> None:
        super().__init__(503, "service_unavailable", detail)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Loads both models once at startup — the entire reason this runs as a
    long-lived service instead of a per-request script (see
    ML_SERVICE_INTEGRATION_PLAN.md §3). Fails fast on startup, matching the
    TS backend's Neo4j-connection convention: a broken model/index should
    stop the service from coming up in a silently-broken state, not be
    discovered on the first request.
    """
    detection_service = DetectionService()

    # Neo4j is the RAG corpus store and vector index (see neo4j_store.py), so
    # missing connection settings are a hard startup failure, exactly like a
    # missing detection model -- not something to discover on the first
    # /search request.
    neo4j_settings = load_neo4j_settings()
    if neo4j_settings is None:
        raise RuntimeError(MISSING_NEO4J_MESSAGE)
    rag_store = RagStore(
        uri=neo4j_settings.uri,
        username=neo4j_settings.username,
        password=neo4j_settings.password,
        database=neo4j_settings.database,
    )
    search_service = SearchService(store=rag_store)

    logger.info("Loading YOLO detection model...")
    detection_service.load()
    logger.info("Detection model ready. Classes: %s", detection_service.class_names)

    # Second, complementary detector for benchmarking (see /detect/compare).
    # Deliberately NOT fail-fast, unlike the primary model above: this one is
    # additive, so a missing or unloadable checkpoint must degrade to "compare
    # unavailable" rather than stop the service and take the existing /detect
    # flow down with it.
    hf_detection_service: DetectionService | None = DetectionService(
        model_path=HF_MODEL_PATH, source=SOURCE_HF
    )
    try:
        logger.info("Loading complementary HF YOLOv8s detection model...")
        hf_detection_service.load()
        logger.info("HF detection model ready. Classes: %s", hf_detection_service.class_names)
    except Exception as error:  # noqa: BLE001 — optional model must never block startup
        logger.warning(
            "Complementary HF model unavailable (%s); /detect/compare will return 503. "
            "/detect is unaffected and continues to use the primary model.",
            error,
        )
        hf_detection_service = None

    logger.info("Connecting to Neo4j and loading the RAG embedding model...")
    search_service.load()
    logger.info("Search service ready (Neo4j vector index).")

    app.state.detection_service = detection_service
    app.state.hf_detection_service = hf_detection_service
    app.state.search_service = search_service
    try:
        yield
    finally:
        # Release the Neo4j connection pool so the process exits cleanly,
        # mirroring the TS backend's closeDriver() on shutdown.
        search_service.close()
        logger.info("ML service shutting down.")


app = FastAPI(
    title="CircuitLoop ML Service",
    version="0.1.0",
    description="Internal-only: YOLO+OCR detection and Neo4j-backed vector retrieval. Not exposed to the browser.",
    lifespan=lifespan,
)


@app.middleware("http")
async def correlation_id_logging(request: Request, call_next):
    """Propagates the TS backend's X-Correlation-Id (Phase 3) into this
    service's logs, per ML_SERVICE_INTEGRATION_PLAN.md §8, so a single
    detection/search request can be traced across both services' logs."""
    correlation_id = request.headers.get("X-Correlation-Id", "-")
    started_at = time.monotonic()
    logger.info("[%s] %s %s started", correlation_id, request.method, request.url.path)
    response = await call_next(request)
    elapsed_ms = (time.monotonic() - started_at) * 1000
    logger.info(
        "[%s] %s %s -> %d (%.1fms)",
        correlation_id,
        request.method,
        request.url.path,
        response.status_code,
        elapsed_ms,
    )
    response.headers["X-Correlation-Id"] = correlation_id
    return response


@app.exception_handler(MlServiceError)
async def handle_ml_service_error(_request: Request, exc: MlServiceError) -> JSONResponse:
    logger.warning("%s: %s", exc.error, exc.detail)
    return JSONResponse(status_code=exc.status_code, content=ErrorResponse(error=exc.error, detail=exc.detail).model_dump())


@app.exception_handler(RequestValidationError)
async def handle_validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    # Re-shaped into this service's own ErrorResponse envelope so the TS
    # client (Phase 3) only has to handle one error shape, not FastAPI's
    # default validation-error shape as a separate case.
    detail = "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors())
    logger.warning("validation_error: %s", detail)
    return JSONResponse(status_code=422, content=ErrorResponse(error="validation_error", detail=detail).model_dump())


@app.exception_handler(Exception)
async def handle_unexpected_error(_request: Request, exc: Exception) -> JSONResponse:
    logger.error("Unhandled error: %s", exc, exc_info=True)
    return JSONResponse(status_code=500, content=ErrorResponse(error="internal_error").model_dump())


def _state(request: Request) -> State:
    return request.app.state


@app.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    state = _state(request)
    detection_service: DetectionService = state.detection_service
    search_service: SearchService = state.search_service
    return HealthResponse(
        status="ok",
        model_loaded=detection_service.is_loaded,
        # Now a real readiness check on Neo4j's vector index, not just an
        # in-process "did we load a file" flag as it was under FAISS.
        index_loaded=search_service.is_loaded and search_service.is_index_online(),
    )


async def _read_validated_image(image: UploadFile) -> bytes:
    """Shared upload validation for the detection endpoints — content type,
    emptiness, and the service-side size cap (defense in depth alongside the
    TS ingress limit, per ML_SERVICE_INTEGRATION_PLAN.md §8)."""
    if image.content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
        raise UnsupportedMediaTypeError(
            f"Unsupported content type {image.content_type!r} — expected one of {sorted(ALLOWED_IMAGE_CONTENT_TYPES)}"
        )

    image_bytes = await image.read()
    if len(image_bytes) == 0:
        raise InvalidImageError("Uploaded image is empty")
    if len(image_bytes) > settings.max_image_bytes:
        raise PayloadTooLargeError(
            f"Image is {len(image_bytes)} bytes, exceeds the {settings.max_image_bytes}-byte limit"
        )
    return image_bytes


@app.post("/detect", response_model=DetectResponse)
async def detect(
    request: Request,
    image: UploadFile = File(...),
    confidence: float = Form(0.25),
) -> DetectResponse:
    image_bytes = await _read_validated_image(image)

    detection_service: DetectionService = _state(request).detection_service
    try:
        detections = detection_service.detect(image_bytes, confidence=confidence)
    except ModelNotLoadedError as exc:
        raise ServiceNotReadyError(str(exc)) from exc
    except ValueError as exc:
        raise InvalidImageError(str(exc)) from exc

    return DetectResponse(
        detections=[
            DetectionModel(
                class_name=d.class_name,
                confidence=d.confidence,
                bbox=d.bbox.__dict__,
                text=d.text,
            )
            for d in detections
        ]
    )


@app.post("/detect/compare", response_model=CompareResponse)
async def detect_compare(
    request: Request,
    image: UploadFile = File(...),
    confidence: float = Form(0.25),
) -> CompareResponse:
    """Runs every loaded detector over the same image and returns each one's
    raw, unmodified detections separately.

    Benchmarking only. Nothing is merged, deduplicated, suppressed, or
    ensembled — the two models may box the same physical component slightly
    differently, and preserving both raw lists is exactly the point so overlap
    can be evaluated later against real PCB images. `/detect` is untouched and
    still serves the primary model alone.
    """
    image_bytes = await _read_validated_image(image)

    state = _state(request)
    services: list[DetectionService] = [state.detection_service]
    if state.hf_detection_service is not None:
        services.append(state.hf_detection_service)

    models: list[ModelDetectionsModel] = []
    for service in services:
        try:
            detections = service.detect(image_bytes, confidence=confidence)
        except ModelNotLoadedError as exc:
            raise ServiceNotReadyError(str(exc)) from exc
        except ValueError as exc:
            raise InvalidImageError(str(exc)) from exc

        models.append(
            ModelDetectionsModel(
                source=service.source,
                model_path=service.model_path.name,
                class_count=len(service.class_names),
                detections=[
                    DetectionModel(
                        class_name=d.class_name,
                        confidence=d.confidence,
                        bbox=d.bbox.__dict__,
                        text=d.text,
                    )
                    for d in detections
                ],
            )
        )

    return CompareResponse(models=models)


@app.post("/search", response_model=SearchResponse)
async def search(request: Request, body: SearchRequest) -> SearchResponse:
    search_service: SearchService = _state(request).search_service
    try:
        search_kwargs = {"top_k": body.top_k}
        if body.min_score is not None:
            search_kwargs["min_score"] = body.min_score
        results = search_service.search(body.query, **search_kwargs)
    except SearchServiceNotLoadedError as exc:
        raise ServiceNotReadyError(str(exc)) from exc

    return SearchResponse(
        results=[
            SearchResultModel(
                part_name=r.part_name,
                section=r.section,
                source_file=r.source_file,
                text=r.text,
                score=r.score,
            )
            for r in results
        ]
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.host, port=settings.port)
