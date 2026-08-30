# CircuitLoop

AI-powered PCB salvage assistant for identifying, analyzing, and evaluating reusable electronic components.

## Architecture

Four processes run together:

| Part | What it does | Address |
|---|---|---|
| **Neo4j** | Database — application data *and* the RAG corpus + vector index | `localhost:7687` |
| **ML service** (Python, `ml-service/`) | Gemini component detection + Neo4j vector retrieval | `127.0.0.1:8001` |
| **Backend** (Node.js, `backend/`) | REST API, orchestrates everything | `127.0.0.1:8000` |
| **Frontend** (React + Vite, `frontend/`) | The web UI | `localhost:5173` |

The frontend talks only to the backend; the backend talks to Neo4j and the ML service. The ML service also talks to Neo4j, but *only* for the RAG datasheet corpus — see [RAG](#rag-datasheet-retrieval) below.

## Quick start

Full instructions — prerequisites, Neo4j, environment variables — are in
[`SETUP_GUIDE.md`](SETUP_GUIDE.md). In short:

```powershell
# 1. Install (once). The ML step downloads ~1-2 GB.
npm run install:all
cd ml-service; python -m venv .venv; .venv\Scripts\python.exe -m pip install -r requirements.txt; cd ..

# 2. Start Neo4j (Neo4j Desktop or a service), then set the same
#    NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD in BOTH backend\.env and
#    ml-service\.env (copy each .env.example).

# 3. Run all three app services in one terminal:
npm run dev
```

The ML service loads models for ~15–25 s; the frontend waits for it, so once
Vite prints `http://localhost:5173` the stack is fully ready — open it and scan.
`Ctrl+C` stops everything. (Close any leftover dev terminals first — `npm run
dev` fails if 8000 / 8001 / 5173 are already taken.)

## Tests

```powershell
npm test                                   # backend (DB tests skip if Neo4j is off)
cd ml-service; .venv\Scripts\python.exe -m pytest
```

## RAG (datasheet retrieval)

The assistant grounds its answers in a corpus of vendor datasheet excerpts. **Neo4j stores that corpus and performs the vector similarity search** — chunk text, metadata and the 384-dimension embedding all live on one `(:DatasheetChunk)` node, queried through the `datasheet_chunk_embedding_index` vector index.

```
PDFs → chunks → embeddings → Neo4j (:DatasheetChunk) → vector index → similarity search → assistant prompt
```

The corpus is built offline and is **not** rebuilt on startup. To populate a fresh database:

```powershell
cd ml-service; .venv\Scripts\python.exe pipeline/ingest.py
```

Ingestion is idempotent — re-running it rewrites the same nodes rather than duplicating them. Full details (schema, index configuration, rebuild and verification commands) are in [`ml-service/README.md`](ml-service/README.md#rag-corpus-neo4j).

> This replaced an earlier FAISS index + `metadata.json` pair. FAISS is no longer a dependency and is not part of the architecture.

## The assistant

Ask about any detected component. Each question is answered from four sources, kept distinct in the prompt so the model can say which one it is relying on:

| | Source | Scope |
|---|---|---|
| **A** | The component's stored record — type, OCR marking, status, detection confidence, board position, provenance | That component only, owner-checked |
| **B** | Its full test history, with totals | That component only, owner-checked |
| **C** | Datasheet excerpts retrieved from Neo4j, each labelled as this part's own datasheet or a different part's | Global, public |
| **D** | The model's general electronics knowledge, flagged as such | — |

Retrieval is **component-aware**: the query embedded is `"<marking> <type> <question>"`, so asking "what is the maximum operating voltage?" about an ICM7555 retrieves the ICM7555 datasheet rather than whichever part happens to match the question wording. Excerpts scoring below `CIRCUITLOOP_RAG_MIN_SCORE` are dropped and the prompt says plainly that no datasheet evidence was found.

Follow-up questions work: the client replays the recent turns of the current component's thread with each request, so "why?" resolves against the previous answer. That history is bounded (most recent 10 turns reach the model), validated server-side, and accepts only `user`/`assistant` roles — a client-supplied `system` turn is rejected outright, since the system prompt is assembled server-side and is the sole carrier of the assistant's policy.

**Isolation.** Every component access is authorised from `component_id` plus the session, so one user can never read another's component — and nothing a client asserts in the replayed transcript can widen that. Conversation history lives only in the browser and in the request; the server stores none of it. The datasheet corpus is global public reference material and contains no user data.
