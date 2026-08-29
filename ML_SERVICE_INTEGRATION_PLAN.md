# CircuitLoop — Python ML Service Integration Plan

> ### ⚠️ Superseded in one area: RAG storage and retrieval
>
> This document is a **historical planning record** and is left otherwise
> intact. One part of it no longer describes the built system: everywhere
> below that specifies **FAISS** as the RAG vector store — notably §1's
> inventory, §3's split table, §6, and §9 Phase 1 — has been superseded.
>
> **As built:** Neo4j is the RAG store *and* the vector-search layer.
> Datasheet chunks live on `(:DatasheetChunk)` nodes with their text,
> metadata and 384-dimension embedding on the same node, queried through the
> `datasheet_chunk_embedding_index` vector index. `faiss-cpu` is no longer a
> dependency, and `vector_db/` + `data/metadata.json` no longer exist.
>
> This also narrows §7's "Python does not write to Neo4j": that rule still
> holds for all **application** data (User/Scan/Component/TestResult remain
> exclusively the TypeScript backend's), but the ML service now reads and
> writes the `(:DatasheetChunk)` corpus. See `ml-service/neo4j_store.py`'s
> module docstring for why that exception is justified, and
> [`ml-service/README.md`](./ml-service/README.md#rag-corpus-neo4j) for the
> current architecture.
>
> §6's core recommendation — retrieval in Python, **generation in TypeScript**
> — is unchanged and still how the system works.

> **Source of truth this plan builds on:** [`CIRCUIT_LOOP_PLAN.md`](./CIRCUIT_LOOP_PLAN.md) (overall architecture/requirements) and [`BACKEND_IMPLEMENTATION_PLAN.md`](./BACKEND_IMPLEMENTATION_PLAN.md) (the TS+Neo4j backend, already implemented for Scan/Component/TestResult/Dashboard — see its §0b milestone record). This document does not redesign either; it plans **only** how the existing Python ML/RAG code integrates with that backend. **Planning only — no code, config, dependency, or route changes are made in this pass.**

---

## 0. Framing — read this before anything else below

**`main` has zero Python ML/RAG code today.** Every Python file this document discusses exists only on the unmerged `origin/RAG` and/or `origin/rag-integration` branches. Nowhere below should "exists" be read as "is live in production" — Section 1's table tags every item's exact location.

**A naming collision worth flagging up front:** `origin/rag-integration:backend/` is a **Python** FastAPI+SQLAlchemy CRUD service (scans/components/tests routers, SQLAlchemy models). It is **fully retired** — superseded by the **TypeScript** `backend/` already built and verified this session (Neo4j-backed, per `BACKEND_IMPLEMENTATION_PLAN.md` §0b). Same directory name, two unrelated things. From here on, "`backend/`" means the TS one unless explicitly marked "Python `backend/` (retired)".

---

## 1. Existing Python Functionality

| File / module | Location | What it does | Input → Output | Readiness |
|---|---|---|---|---|
| `rag/scripts/yolo_ocr.py` | `origin/RAG`, also `origin/rag-integration:rag/scripts/` | Loads trained YOLOv11 model (`ultralytics`), runs detection, crops each box, runs Tesseract OCR (`pytesseract`) per crop | image path → `[{class_id, class_name, confidence, box:[x1,y1,x2,y2], text}]`, written to a JSON file | **Prototype-but-real**: uses the actual trained model (`models/pcb_yolo11s_best.pt`, checked in), but is CLI-only (`argparse`, writes to disk) — never called from any API. `extract_detected_text()` is already a plain function internally, just never imported elsewhere. |
| `rag/scripts/extract_and_chunk.py` | `origin/RAG`, `origin/rag-integration:rag/scripts/` | PDF datasheets → section-aware text chunks (`pdfplumber`) | folder of PDFs → `data/chunks.json` | Working offline pipeline step, CLI, run manually. |
| `rag/scripts/create_embeddings.py` | same | Chunks → sentence embeddings | `data/chunks.json` → `data/embeddings.npy` + `data/metadata.json` (`sentence-transformers/all-MiniLM-L6-v2`) | Working offline pipeline step, CLI, run manually. |
| `rag/scripts/build_faiss_index.py` | same | Embeddings → FAISS index | `data/embeddings.npy` → `vector_db/circuitloop.index` + `vector_db/metadata.json` (`IndexFlatL2`) | Working offline pipeline step, CLI, run manually. |
| `rag/scripts/test_search.py` | same | Interactive manual CLI search tester | stdin query → printed top-5 chunks | Dev tool only, not a service. |
| `rag/app.py` | `origin/RAG`, `origin/rag-integration:rag/app.py` | Standalone FastAPI app, single `GET /search?query=` endpoint over the FAISS index | query string → top-3 `{part_name, section, source_file, text}` | **Real, working, retrieval-only.** No generation. |
| `backend/services/ai_service.py` (Python) | `origin/rag-integration` only | **Duplicate** of `rag/app.py`'s retrieval logic, re-implemented in-process inside the (retired) Python CRUD backend, called by its `POST /api/assistant` | `{component_id, question}` → top-3 chunks concatenated as `message` | Real, retrieval-only, but a straight duplicate of `rag/app.py` — no clean service boundary exists today. |
| `backend/` Python CRUD (`main.py`, `models.py`, `database.py`, `routers/*.py`) | `origin/Backend`, `origin/rag-integration:backend/` | Scans/components/tests/dashboard CRUD over SQLAlchemy+SQLite | — | **Retired.** Fully superseded by the TS backend built this session. Listed here only so it isn't confused with anything below. |

**Cross-cutting dependency evidence:** both `origin/rag-integration`'s root `pyproject.toml` and `backend/pyproject.toml` (Python) declare the *identical* full list — `fastapi`, `sqlalchemy`, `ultralytics`, `opencv-python`, `pytesseract`, `faiss-cpu`, `sentence-transformers`, everything, undifferentiated. There is no existing packaging boundary between "ML code" and "CRUD backend code" in Python — Section 3/9 propose creating one for the first time, not preserving one that already exists.

---

## 2. Service Boundaries

| Stays in Python (`ml-service/`, new) | Stays/lives in TypeScript (`backend/`, existing) |
|---|---|
| YOLO detection (`ultralytics`) | Public API endpoints, request validation |
| OCR (`pytesseract`) | Business logic (component status, salvage priority, etc.) |
| Embedding + FAISS retrieval (`sentence-transformers`, `faiss-cpu`) | Neo4j persistence (all of it) |
| Nothing else — no persistence, no business rules, no auth, no orchestration between other services | Scan/Component/TestResult workflows (already built) |
| | ESP32 communication, monitoring (planned, per `BACKEND_IMPLEMENTATION_PLAN.md`) |
| | LLM generation for the assistant (see §6 — reasoned, not assumed) |
| | Orchestration: calling the Python service, mapping its output, deciding what happens next |

Python is a **stateless inference/retrieval primitive provider**, nothing more. It never decides what a detection *means* for the product (that's a `ComponentType`/business concept, owned by TS) — it returns what the model actually said (raw class name, raw confidence, raw OCR text) and lets TS interpret it.

---

## 3. Communication Architecture

| Option | Verdict |
|---|---|
| **Internal HTTP (FastAPI)** | **Recommended.** Model + FAISS index stay loaded in memory across requests (load-once-at-startup); a proven pattern already exists in this exact codebase (`rag/app.py`); language-agnostic contract; trivial to add a timeout/retry layer on the TS side. |
| Direct process execution (`child_process.exec("python yolo_ocr.py ...")` per request) | Rejected — reloads the YOLO model and sentence-transformer from disk on every single call. For a model this size, that's the dominant cost of the request; unacceptable latency for something the user is waiting on. |
| Message queue (e.g. a job queue + polling) | Rejected for now — this is a synchronous "upload a photo, see results" interaction; a queue adds infrastructure (broker, worker, poll/webhook) with no benefit at this scale, and nothing in the project's actual requirements calls for async/batch processing. Worth revisiting only if detection volume/latency ever demands background processing — not today. |
| gRPC | Rejected — no requirement for streaming or binary-protocol performance here; adds a codegen/tooling dependency neither side currently has, for no measurable benefit over plain JSON/HTTP at this scale. |

**Chosen: an internal FastAPI service (`ml-service/`), bound to `127.0.0.1` only, called by the TS backend over plain HTTP/JSON** (multipart for the image upload). Not exposed to the frontend or network directly — the TS backend is the only client.

---

## 4. Detection Flow

```text
Frontend (ScanPCB.tsx)                                    [exists, currently sessionStorage-only — no upload call yet]
    ↓ multipart image upload
TS backend: POST /api/scans/:id/upload                    [NEW — route+controller, per BACKEND_IMPLEMENTATION_PLAN.md Phase C]
    ↓ forwards image
TS backend: services/mlServiceClient.ts                   [NEW — thin HTTP client, timeout+retry+error translation]
    ↓ POST /detect (multipart)
ml-service: app.py → detection.py                         [NEW service wrapping the refactored rag/scripts/yolo_ocr.py logic]
    ↓ runs YOLO + per-box OCR
ml-service: returns raw detections (class_name, confidence, bbox, ocr text)   [see §5 — NOT ComponentType yet]
    ↓
TS backend: services/detectionService.ts                  [NEW — maps class_name → ComponentType (blocked on §7's open item)]
    ↓ builds ComponentInput[]
TS backend: componentService.createDetectionBatch          [EXISTING — reused verbatim, built this session]
    ↓
TS backend: componentRepository.createDetectionBatch        [EXISTING — reused verbatim, built this session]
    ↓ Cypher: MATCH (s:Scan) UNWIND ... CREATE (:Component) CREATE (s)-[:DETECTED]->(c)
Neo4j
    ↓
TS backend: ComponentResponse[]                              [EXISTING dto.ts mapping, reused]
    ↓
Frontend: renders detected components                         [Analysis.tsx — currently mock-only, wiring is separate follow-up work per CIRCUIT_LOOP_PLAN.md Phase D]
```

---

## 5. API Contracts (TS ↔ Python)

### `POST /detect` (ml-service)

Request: `multipart/form-data`, field `image` (PNG/JPEG), optional field `confidence` (float, default `0.25`, matches `yolo_ocr.py`'s existing default).

Python response model (new, Pydantic):
```python
class BoundingBox(BaseModel):
    x1: int
    y1: int
    x2: int
    y2: int

class Detection(BaseModel):
    class_name: str        # raw YOLO label — NOT a ComponentType, see the open item below
    confidence: float
    bbox: BoundingBox
    text: str               # OCR result for this box; "" if OCR found nothing or failed on this box (see §8)

class DetectResponse(BaseModel):
    detections: list[Detection]
```

TS-side mirror (new, `backend/src/types/mlService.ts`):
```typescript
export interface MlBoundingBox { x1: number; y1: number; x2: number; y2: number; }
export interface MlDetection { class_name: string; confidence: number; bbox: MlBoundingBox; text: string; }
export interface MlDetectResponse { detections: MlDetection[]; }
```

**Important, explicit, unresolved item — do not guess:** the trained model's actual `class_name` values (YOLO's `result.names`) are **not present anywhere in this repository** — only the opaque `.pt` weights are checked in. Mapping `class_name` → the domain `ComponentType` enum (`resistor | capacitor | led | diode | transistor | ic | microcontroller | unknown`) **cannot be written until that label list is obtained** — either by running the model once against a sample image and inspecting `result.names`, or by asking the project owner directly. Until then, any detection with an unrecognized/unmapped class name maps to `"unknown"` (a value the domain model already supports) rather than a guessed-at real type.

### `POST /search` (ml-service)

Request: `{ "query": string, "top_k"?: number }` (default `top_k=3`, matching current behavior).
Response: `{ "results": [{ "part_name": string, "section": string, "source_file": string, "text": string }] }` — this is `rag/app.py`'s existing shape, kept as-is.

### `GET /health` (ml-service)

`{ "status": "ok", "model_loaded": boolean, "index_loaded": boolean }` — lets the TS client (and future monitoring) distinguish "service up but still loading" from "fully ready."

### Timeouts, retries, errors (TS client side)

- `/detect`: 30s timeout (YOLO + per-box OCR on a full image can legitimately take several seconds). `/search`: 10s. `/health`: 3s.
- Retry policy: **at most 1 retry**, only on network error or 5xx, only for `/detect` and `/search` — safe because the Python service is stateless and doesn't persist anything, so calling it twice has no side effect to worry about. No retry on 4xx (a validation problem retrying won't fix).
- Error shape from `ml-service` on failure: `{ "error": string, "detail"?: string }`; TS translates this into its own existing `{"detail": ...}` envelope via a new `UpstreamServiceError` (extends the existing `AppError` in `backend/src/utils/errors.ts`), status `502` (bad/invalid response) or `503` (service unreachable/timeout).

---

## 6. RAG Integration

Kept explicitly separated, per the requested refinement:

- **Current implementation (branch-only, `rag/app.py` / `ai_service.py`):** retrieval-only. Given a question, embed it, FAISS-search, return the top-3 raw chunk texts. No LLM call anywhere in the repo, no synthesis.
- **Actual project requirement** (`CIRCUIT_LOOP_PLAN.md` §10; the original brief's example questions like *"Why might this component be failing?"*, *"Explain the health status of my CPU"*): the assistant must produce a **synthesized, context-aware answer** — component metadata + test/health results + retrieved knowledge → one coherent response. Retrieval-only is today's *state*, not the target.
- **Recommended future architecture:** `ml-service/search.py` keeps doing retrieval only — that part is genuinely Python-ecosystem-bound (`sentence-transformers` + `faiss-cpu`) and stays exactly where it is. The **generation step is recommended to live in TS**, not Python — reasoned below, not assumed, since `CIRCUIT_LOOP_PLAN.md`/`BACKEND_IMPLEMENTATION_PLAN.md` originally sketched it inside Python's `ai_service.py` back when the whole backend was Python:
  - An LLM chat-completion call is a plain HTTP request to a provider — it doesn't need any Python ML library, so it doesn't meet the bar of "genuinely depends on the Python ML/AI ecosystem" that justifies putting something in `ml-service`.
  - TS is the only side with direct Neo4j access to the component/test/health context the answer needs to be grounded in (§5/§6 of `BACKEND_IMPLEMENTATION_PLAN.md`).
  - The alternative (generation in Python) would require either giving Python read access to Neo4j — rejected below — or having TS forward the full assembled context into every Python request just so Python can perform a step with no ecosystem-specific reason to own it. More moving parts, no benefit.
  - This corrects `CIRCUIT_LOOP_PLAN.md` §10 / `BACKEND_IMPLEMENTATION_PLAN.md` §7.2's Python-era placement; that correction should be folded back into those documents in a future pass, not this one.
  - This is **not** "build a generic chatbot" — it's specifying where the *already-planned* `/api/assistant` endpoint's data flows, per the user's explicit caution not to scope-creep into a new feature.

Future flow (not built yet — this is design, matching `BACKEND_IMPLEMENTATION_PLAN.md`'s existing Phase J): `TS: load Component + latest TestResult + latest HealthReport from Neo4j → TS: POST /search to ml-service → TS: assemble prompt (context + chunks) → TS: call chosen LLM provider (still undecided — not resolved by this document) → TS: return answer`.

---

## 7. Neo4j Integration

Detections become graph data **exclusively through TS**, reusing exactly what was built this session — no new database logic, no duplicate write path:

```text
ml-service returns raw detections
    ↓ (TS) detectionService.ts maps class_name → ComponentType (blocked on §5's open item) + assembles ComponentInput[]
    ↓ (TS) componentService.createDetectionBatch(scanId, inputs)         — EXISTING, reused verbatim
    ↓ (TS) componentRepository.createDetectionBatch(scanId, inputs)      — EXISTING, reused verbatim
    ↓ Cypher (already written, BACKEND_IMPLEMENTATION_PLAN.md §5.7): MATCH (s:Scan) UNWIND $detections AS d
      CREATE (c:Component {...}) CREATE (s)-[:DETECTED]->(c) RETURN c
Neo4j: (:Scan)-[:DETECTED]->(:Component)
```

**Python does not write to Neo4j.** No architectural reason was found in this codebase to justify an exception (Python has no existing Neo4j client, no credentials, and the whole point of the TS backend's repository layer is to be the single place that owns graph writes — duplicating that in Python would immediately create two divergent code paths for the same mutation). If this is ever revisited, it would need a documented, specific reason — none exists today.

---

## 8. Reliability and Security

- **Network exposure:** `ml-service` binds to `127.0.0.1` only — not reachable outside the host. No inter-service auth token needed at this scale; documented upgrade path (not built now) is a shared-secret header (`X-Internal-Service-Key`, env-var-configured on both sides) if the service is ever exposed beyond localhost.
- **Request size limits:** image upload capped (e.g. 10MB) at the TS ingress (`multer` limits, per `BACKEND_IMPLEMENTATION_PLAN.md` §10) **and** independently at the FastAPI service (defense in depth — the TS layer shouldn't be the only thing standing between an oversized request and the Python process).
- **File validation:** content-type checked at both hops (PNG/JPEG only).
- **Timeout handling:** see §5 — TS-side `AbortController`-based timeouts per endpoint; a hung Python service can't hang an API request indefinitely.
- **Python service unavailable:** TS client catches connection-refused/timeout, raises `UpstreamServiceError` → `503 {"detail": "Detection service unavailable"}` (or `502` for a reachable-but-erroring service) — never an unhandled crash or a hung request.
- **Invalid ML responses:** the TS client validates the Python response shape with a Zod schema (matching the existing validation convention) before using it; a malformed response is treated as a `502`, logged, not silently trusted.
- **Partial detection failures:** `yolo_ocr.py`'s current OCR step doesn't isolate per-box failures — a single crop's OCR error would currently propagate and fail the whole request. Flagged as a Python-service-prep task (§9 Phase 1): catch per-box OCR exceptions, return `text: ""` for that box, and let the rest of the detections through rather than failing the entire image.
- **Correlation IDs:** TS generates a request id (reusing the existing `utils/ids.ts::newId()`) and sends it as `X-Correlation-Id` on every call to `ml-service`; Python logs it too, so a single detection request can be traced across both services' logs.

---

## 9. Implementation Phases (not executed in this pass — planning only)

Each phase lists exactly what's reused, modified, or newly created, per the `rag/`→`ml-service/` mapping from §0/§3.

### Phase 1 — Python service preparation
- **Reused (moved, logic unchanged):** `rag/scripts/extract_and_chunk.py`, `create_embeddings.py`, `build_faiss_index.py` → `ml-service/pipeline/`. `rag/data/`, `rag/vector_db/` → `ml-service/data/`, `ml-service/vector_db/`. `models/pcb_yolo11s_best.pt` → `ml-service/models/`.
- **Reused (refactored):** `rag/scripts/yolo_ocr.py`'s `extract_detected_text()` → `ml-service/detection.py` (packaged for import, in-memory image input, model loaded once at service startup, per-box OCR failure isolation per §8).
- **Consolidated (retiring a duplicate):** `rag/app.py` + `backend/services/ai_service.py`'s retrieval logic → **one** `ml-service/search.py`. Both originals retired.
- **New:** `ml-service/app.py` (FastAPI app: `/detect`, `/search`, `/health`), `ml-service/schemas.py` (Pydantic models per §5), `ml-service/pyproject.toml`/`requirements.txt` scoped to only what ML needs (`fastapi`, `uvicorn`, `ultralytics`, `opencv-python`, `pytesseract`, `Pillow`, `faiss-cpu`, `sentence-transformers`, `numpy`) — explicitly **not** `sqlalchemy` or anything CRUD-related, correcting the undifferentiated dependency list found in §1.
- **Verifies:** the YOLO class-name list (§5's open item) — must happen in this phase, before Phase 4 can map classes to `ComponentType`.

### Phase 2 — Internal API contract
- **New:** finalize `ml-service/schemas.py` (Pydantic) and `backend/src/types/mlService.ts` (TS interfaces) together, per §5 — kept manually in sync, same pattern already used for `schemas.py`↔`dto.ts` in the main API.

### Phase 3 — TS service/client
- **New:** `backend/src/services/mlServiceClient.ts` (fetch wrapper, timeouts, ≤1 retry, error translation into `UpstreamServiceError`).
- **Modified:** `backend/src/utils/errors.ts` (+`UpstreamServiceError`), `backend/src/config/env.ts` (+`ML_SERVICE_URL` and related settings, extending the existing `Settings` interface/`.env`/`.env.example`, same pattern as `NEO4J_*`).

### Phase 4 — Detection endpoint integration
- **New:** `backend/src/routes/scans.ts` addition (`POST /:id/upload`, using `multer` — a new dependency, memory storage + size limit), `backend/src/controllers/scanController.ts` addition, `backend/src/services/detectionService.ts` (orchestrates client call → class-name mapping → `ComponentInput[]`), `backend/src/validation/componentTypeMapping.ts` (the class-name→`ComponentType` table — cannot be written until Phase 1's verification step completes).
- **Reused, unmodified:** `componentService.createDetectionBatch`, `componentRepository.createDetectionBatch`.

### Phase 5 — Neo4j persistence
- **Reused only** — no new code; `detectionService.ts` calls the existing functions from Phase 4.

### Phase 6 — Testing
- **New (Python):** `ml-service/tests/test_detection.py`, `test_search.py` (FastAPI `TestClient`, small sample image).
- **New (TS):** `backend/tests/mlServiceClient.test.ts` (mocked Python HTTP responses — timeout/retry/error-translation), `backend/tests/scanUpload.test.ts` (API-level, `mlServiceClient` mocked so the existing TS suite still runs without Python/YOLO installed, following the `api.test.ts` pattern already established this session).

### Phase 7 — End-to-end verification (manual, not run now)
- Start Neo4j + `ml-service` + TS `backend` together; upload a real PCB image through `curl`/frontend; confirm `(:Component)` nodes appear in Neo4j with correct `DETECTED` relationships and (once Phase 1's class list is known) correct types; confirm `/search` returns relevant chunks for a sample question.

---

## 10. Recommended Architecture — Summary

```text
Frontend → TS backend (API, validation, business logic, Neo4j, orchestration)
              ↓ internal HTTP (localhost-only)
           ml-service (Python, FastAPI) — YOLO detection + OCR + FAISS retrieval only, stateless, no persistence
```

This is the best fit for CircuitLoop because: (1) it reuses every piece of real, working Python ML code found in the repo (the trained YOLO model, the OCR pipeline, the FAISS/embeddings pipeline) without rewriting any of it into TypeScript, directly honoring the instruction not to touch working ML code; (2) it resolves the one clear code-quality problem found during inspection — the duplicated retrieval logic between `rag/app.py` and `backend/services/ai_service.py` — by consolidating to a single implementation instead of carrying the duplication forward; (3) it keeps the already-built, already-tested TS+Neo4j backend as the single source of truth for persistence and business logic, exactly matching this session's established architecture, with zero new database code required; (4) internal HTTP/FastAPI is the only communication option of the ones considered that avoids reloading expensive models per request while adding no infrastructure beyond what the project already has; and (5) it resolves the LLM-generation placement question with an explicit rationale grounded in the project's own stated service-boundary rule, rather than leaving it ambiguous.
