# CircuitLoop ML Service

Internal-only Python service: YOLO+OCR component detection and FAISS/embeddings RAG retrieval. Called exclusively by the TypeScript `backend/` over internal HTTP — never exposed to the browser. See [`ML_SERVICE_INTEGRATION_PLAN.md`](../ML_SERVICE_INTEGRATION_PLAN.md) for the full architecture and rationale.

**Status: Phases 1–6 complete.** `app.py` serves `/health`, `/detect` and `/search`; `detection.py` and `search.py` are verified-working modules behind them, and the pytest suite under `tests/` runs against the real model and real FAISS index. Phase 7 (manual end-to-end verification with Neo4j + the TS backend against a real PCB photo) is still outstanding — see the note on test images below.

## Origin of the code in this directory

Consolidated from `origin/RAG` / `origin/rag-integration` (branch-only — never on `main`) per `ML_SERVICE_INTEGRATION_PLAN.md`'s mapping table:

| This directory | Came from |
|---|---|
| `models/pcb_yolo11s_best.pt` | `models/pcb_yolo11s_best.pt` (top-level on `rag-integration`) |
| `pipeline/*.py` | `rag/scripts/{extract_and_chunk,create_embeddings,build_faiss_index,test_search}.py` — moved as-is, unchanged |
| `data/`, `vector_db/` | `rag/data/`, `rag/vector_db/` — moved as-is |
| `detection.py` | Refactored from `rag/scripts/yolo_ocr.py` (see its docstring for exactly what changed) |
| `search.py` | Consolidated from **two duplicate implementations**: `rag/app.py` and `backend/services/ai_service.py` (Python, retired). Both originals are retired; this is the one remaining implementation. |

## Setup

```powershell
python -m venv .venv --system-site-packages   # --system-site-packages: this dev machine already had
                                                # torch/sentence-transformers/faiss-cpu/numpy globally;
                                                # reuses them instead of duplicating ~1GB+ of downloads
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

`requirements.txt` is scoped to only what detection/retrieval need — deliberately excludes `sqlalchemy` and anything CRUD-related (see `ML_SERVICE_INTEGRATION_PLAN.md` §1's finding that the old Python branches never had this separation).

## Tesseract OCR binary

`pytesseract` (the Python package) is only a wrapper around the **Tesseract OCR binary**, which is a separate, non-pip install. It **is installed on this machine**: Tesseract v5.4.0 at the Windows default location `C:\Program Files\Tesseract-OCR\tesseract.exe`, which `detection.py` resolves automatically (override with the `TESSERACT_CMD` environment variable). Install from https://github.com/UB-Mannheim/tesseract/wiki on a machine that lacks it.

`detection.py` degrades gracefully either way: each detected region's OCR is attempted independently, and a failure — including "Tesseract not installed" — is caught and logged per-region, returning `text: ""` for that region rather than failing the whole request (`ML_SERVICE_INTEGRATION_PLAN.md` §8).

## OCR quality gate

**An empty `text` is normal and usually correct.** `_ocr_crop` returns `""` unless the read passes a quality gate, so a missing binary is *not* the only reason to see empty strings — most components simply carry no legible marking.

The gate exists because the pipeline previously stored whatever Tesseract emitted straight into a component's `name`, so a switch with no printed marking was named `es` (Tesseract's best guess at moulded plastic texture, measured at confidence 17). `--psm 6` asks Tesseract to assume a uniform block of text, so on a featureless surface it guesses rather than declining.

`image_to_data` is used rather than `image_to_string` specifically so per-word confidence is available to filter on. The thresholds are calibrated from measurements — see the constants at the top of `detection.py` for each value's justification, and `tests/test_detection_service.py` for the junk/legitimate corpora that pin them down. Note that **no rule looks at letter case**: Tesseract alters capitalisation on its own (measured: `SW1` → `Swi`), so a case rule would be a capitalisation policy rather than a quality gate.

## Verified in Phase 1 (see the phase report for full detail)

- `search.py`'s `SearchService` — loads the real moved FAISS index + embedding model, returns real relevant results for a real query.
- `detection.py`'s `DetectionService` — loads the real trained model, runs a full detect() call end-to-end (decode → inference → per-box OCR attempt), including graceful handling of the missing-Tesseract case.
- `pipeline/build_faiss_index.py` — re-run from its new location, correctly resolved its relative paths, produced a valid index.
- **The model's real class list** (`model.names`), obtained by actually loading the model — not guessed: `{0: battery, 1: buzzer, 2: capacitor, 3: display, 4: ic, 5: relay, 6: resistor, 7: switch}`. The mismatch this revealed against the TypeScript `ComponentType` enum has since been resolved — the mapping lives in `backend/src/services/detectionService.ts` as `YOLO_CLASS_TO_COMPONENT_TYPE`, and `tests/test_detection_service.py::test_real_model_class_names_match_the_verified_label_set` re-checks this list against the real `.pt` on every run so a retrained model with different classes fails loudly instead of silently producing `unknown` components.

## Test images

There is no real PCB photo in this repo. The pytest fixtures use `frontend/src/assets/hero.png` at a very low confidence threshold to force detections — enough to exercise decode → YOLO → OCR end-to-end, but not a substitute for a real board. `data/yolo_ocr.json` holds recorded output from a real PCB, but the source image was never checked in and the file records no OCR confidences.
