# CircuitLoop ML Service

Internal-only Python service: YOLO+OCR component detection and Neo4j-backed RAG retrieval. Called exclusively by the TypeScript `backend/` over internal HTTP — never exposed to the browser. See [`ML_SERVICE_INTEGRATION_PLAN.md`](../ML_SERVICE_INTEGRATION_PLAN.md) for the original architecture and rationale, and the [RAG section](#rag-corpus-neo4j) below for the parts that have since changed.

**Status: Phases 1–6 complete, plus the RAG storage migration to Neo4j.** `app.py` serves `/health`, `/detect` and `/search`; `detection.py` and `search.py` are verified-working modules behind them, and the pytest suite under `tests/` runs against the real model and the real Neo4j vector index. Phase 7 (manual end-to-end verification against a real PCB photo) is still outstanding — see the note on test images below.

## Origin of the code in this directory

Consolidated from `origin/RAG` / `origin/rag-integration` (branch-only — never on `main`) per `ML_SERVICE_INTEGRATION_PLAN.md`'s mapping table:

| This directory | Came from |
|---|---|
| `models/pcb_yolo11s_best.pt` | `models/pcb_yolo11s_best.pt` (top-level on `rag-integration`) |
| `pipeline/extract_and_chunk.py` | `rag/scripts/extract_and_chunk.py` — moved as-is, unchanged |
| `pipeline/ingest.py` | Replaces `rag/scripts/{create_embeddings,build_faiss_index}.py` — now embeds and writes to Neo4j instead of producing `embeddings.npy` + a FAISS index |
| `data/chunks.json` | `rag/data/chunks.json` — moved as-is. The other `rag/data/*` and all of `rag/vector_db/` were FAISS-era artifacts and have been deleted |
| `detection.py` | Refactored from `rag/scripts/yolo_ocr.py` (see its docstring for exactly what changed) |
| `search.py` | Consolidated from **two duplicate implementations**: `rag/app.py` and `backend/services/ai_service.py` (Python, retired). Both originals are retired; this is the one remaining implementation. |

## Setup

```powershell
python -m venv .venv --system-site-packages   # --system-site-packages: this dev machine already had
                                                # torch/sentence-transformers/numpy globally;
                                                # reuses them instead of duplicating ~1GB+ of downloads
.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env                          # then set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD
```

Neo4j is a **required** dependency: it stores the RAG corpus and serves vector search, so the service refuses to start without a reachable database (same fail-fast convention as the TypeScript backend).

`requirements.txt` is scoped to only what detection/retrieval need — deliberately excludes `sqlalchemy` and anything CRUD-related (see `ML_SERVICE_INTEGRATION_PLAN.md` §1's finding that the old Python branches never had this separation).

## Tesseract OCR binary

`pytesseract` (the Python package) is only a wrapper around the **Tesseract OCR binary**, which is a separate, non-pip install. It **is installed on this machine**: Tesseract v5.4.0 at the Windows default location `C:\Program Files\Tesseract-OCR\tesseract.exe`, which `detection.py` resolves automatically (override with the `TESSERACT_CMD` environment variable). Install from https://github.com/UB-Mannheim/tesseract/wiki on a machine that lacks it.

`detection.py` degrades gracefully either way: each detected region's OCR is attempted independently, and a failure — including "Tesseract not installed" — is caught and logged per-region, returning `text: ""` for that region rather than failing the whole request (`ML_SERVICE_INTEGRATION_PLAN.md` §8).

## OCR quality gate

**An empty `text` is normal and usually correct.** `_ocr_crop` returns `""` unless the read passes a quality gate, so a missing binary is *not* the only reason to see empty strings — most components simply carry no legible marking.

The gate exists because the pipeline previously stored whatever Tesseract emitted straight into a component's `name`, so a switch with no printed marking was named `es` (Tesseract's best guess at moulded plastic texture, measured at confidence 17). `--psm 6` asks Tesseract to assume a uniform block of text, so on a featureless surface it guesses rather than declining.

`image_to_data` is used rather than `image_to_string` specifically so per-word confidence is available to filter on. The thresholds are calibrated from measurements — see the constants at the top of `detection.py` for each value's justification, and `tests/test_detection_service.py` for the junk/legitimate corpora that pin them down. Note that **no rule looks at letter case**: Tesseract alters capitalisation on its own (measured: `SW1` → `Swi`), so a case rule would be a capitalisation policy rather than a quality gate.

## Verified in Phase 1 (see the phase report for full detail)

- `search.py`'s `SearchService` — loads the embedding model and queries the real corpus, returning real relevant results for a real query. (Originally verified against the moved FAISS index; now against the Neo4j vector index — see below.)
- `detection.py`'s `DetectionService` — loads the real trained model, runs a full detect() call end-to-end (decode → inference → per-box OCR attempt), including graceful handling of the missing-Tesseract case.
- **The model's real class list** (`model.names`), obtained by actually loading the model — not guessed: `{0: battery, 1: buzzer, 2: capacitor, 3: display, 4: ic, 5: relay, 6: resistor, 7: switch}`. The mismatch this revealed against the TypeScript `ComponentType` enum has since been resolved — the mapping lives in `backend/src/services/detectionService.ts` as `YOLO_CLASS_TO_COMPONENT_TYPE`, and `tests/test_detection_service.py::test_real_model_class_names_match_the_verified_label_set` re-checks this list against the real `.pt` on every run so a retrained model with different classes fails loudly instead of silently producing `unknown` components.

## Test images

There is no real PCB photo in this repo. The pytest fixtures use `frontend/src/assets/hero.png` at a very low confidence threshold to force detections — enough to exercise decode → YOLO → OCR end-to-end, but not a substitute for a real board. `data/yolo_ocr.json` holds recorded output from a real PCB, but the source image was never checked in and the file records no OCR confidences.

## RAG corpus (Neo4j)

Neo4j is the RAG database **and** the vector-search layer. There is no FAISS index and no JSON lookup table in the runtime path: chunk text, chunk metadata and the embedding vector all live on a single node.

```
datasheet PDFs
   └─ pipeline/extract_and_chunk.py ──> data/chunks.json          (offline, manual)
        └─ pipeline/ingest.py ──> embed (all-MiniLM-L6-v2, normalized)
             └─ Neo4j (:DatasheetChunk) nodes + vector index
                  └─ search.py / POST /search ──> top-k chunks + cosine score
                       └─ TS backend assistantService ──> LLM prompt
```

### Schema

```cypher
(:DatasheetChunk {
  id:         string,   // SHA-256 of (sourceFile, partName, section, text) — unique, content-addressed
  chunkId:    string,   // the pipeline's own "{part}_{section}_{n}" label — provenance only, NOT unique
  text:       string,
  partName:   string,
  section:    string,
  sourceFile: string,
  embedding:  list<float>   // 384 dimensions
})
```

| Object | Name | Purpose |
|---|---|---|
| Constraint | `datasheetchunk_id_unique` | `d.id IS UNIQUE` — the database-level guarantee behind idempotent ingestion |
| Range index | `datasheetchunk_source_file_index` | `d.sourceFile` — per-file corpus management |
| Vector index | `datasheet_chunk_embedding_index` | `d.embedding`, **384** dims, **cosine** |

Declared in two places, both `IF NOT EXISTS`: `ml-service/neo4j_store.py` (so a standalone corpus rebuild works without the backend running) and `backend/src/db/schema.ts` (so the graph schema stays documented in one canonical file). `RagStore.ensure_schema()` re-reads the live index after creating it and **refuses to start on a dimension or similarity mismatch**, so the two declarations cannot silently drift apart.

**Why `id` is a content hash.** The pipeline's own `chunk_id` is `{part}_{section}_{n}`, where `n` restarts at 0 each time a section header recurs within one PDF — so it collides. In the real corpus only **406 of 728** `chunk_id` values are distinct. MERGE-ing on it would have collapsed the corpus to 406 nodes and destroyed 322 chunks. Hashing the content instead is both unique *and* deterministic, which is exactly what makes re-ingestion idempotent.

**Why cosine.** Corpus and query vectors are both L2-normalized, so cosine ranks identically to the squared-L2 distance the old FAISS `IndexFlatL2` used (`L2² = 2 − 2·cos` for unit vectors). Cosine additionally yields a bounded `[0,1]` score, which `/search` now returns — the FAISS path discarded its distance array entirely, so nothing downstream could tell a strong match from a weak one.

### Populating / rebuilding the corpus

```powershell
# From data/chunks.json (embeds, then writes to Neo4j). Idempotent.
.venv\Scripts\python.exe pipeline/ingest.py

# Full rebuild — drops every DatasheetChunk first.
.venv\Scripts\python.exe pipeline/ingest.py --reset

# Report corpus + index state without writing anything.
.venv\Scripts\python.exe pipeline/ingest.py --verify

# Load a precomputed embedding set (metadata JSON + .npy, same length and order).
.venv\Scripts\python.exe pipeline/ingest.py --embedded <metadata.json> <embeddings.npy>

# Manual retrieval spot-check, through the same code path /search uses.
.venv\Scripts\python.exe pipeline/test_search.py "esd rating" --top-k 5
```

Re-running ingestion is safe: every write is a `MERGE` on the content-addressed id, so the corpus is rewritten in place rather than duplicated. `tests/test_rag_store.py::test_ingesting_twice_does_not_duplicate_chunks` pins this.

To extend the corpus, drop new PDFs in a folder, run `extract_and_chunk.py` against it, then `ingest.py`. Only genuinely new chunks create new nodes.

### Why `data/chunks.json` is still here

It is the **ingestion input**, not a runtime store — nothing in the serving path reads it (`tests/test_no_faiss.py` enforces that). It is retained deliberately because the source datasheet PDFs were never checked into this repo, which makes `chunks.json` the only artifact from which the corpus can be rebuilt. Deleting it would make the corpus unreproducible from a clean clone. `data/embeddings.npy`, `data/metadata.json` and the whole `vector_db/` directory *were* runtime FAISS artifacts and have been removed.

### Isolation

`(:DatasheetChunk)` is global, read-only, public vendor-datasheet content with no owner and no `(:User)-[:OWNS]->` edge. It carries no user data, so retrieval cannot leak between accounts. This service reads and writes **only** this label; `User`, `Scan`, `Component`, `TestResult`, `Command` and `HealthReport` remain exclusively the TypeScript backend's, per `ML_SERVICE_INTEGRATION_PLAN.md` §7. See `neo4j_store.py`'s module docstring for why that rule permits this one exception.

### Vector API note

Target server is **Neo4j 2026.07.1**. Verified against it directly rather than assumed:

- `CREATE VECTOR INDEX … OPTIONS { indexConfig: { vector.dimensions, vector.similarity_function } }` — works.
- `db.index.vector.queryNodes` — works, and is what `neo4j_store.query_similar_chunks()` uses.
- That procedure emits a **forward-looking deprecation notice** saying it "is replaced by SEARCH". The `SEARCH` clause is **not implemented on this server version** — it fails to parse under both `CYPHER 5` and `CYPHER 25`. So the deprecated procedure is currently the only working vector-search API here. Revisit when a server version actually ships `SEARCH`; the change is confined to one method.
