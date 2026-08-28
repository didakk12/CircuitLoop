# CircuitLoop

AI-powered PCB salvage assistant for identifying, analyzing, and evaluating reusable electronic components.

## Architecture

Four processes run together:

| Part | What it does | Address |
|---|---|---|
| **Neo4j** | Database | `localhost:7687` |
| **ML service** (Python, `ml-service/`) | YOLO component detection + OCR + FAISS retrieval | `127.0.0.1:8001` |
| **Backend** (Node.js, `backend/`) | REST API, orchestrates everything | `127.0.0.1:8000` |
| **Frontend** (React + Vite, `frontend/`) | The web UI | `localhost:5173` |

The frontend talks only to the backend; the backend talks to Neo4j and the ML service.

## Quick start

Full instructions — prerequisites, Neo4j, environment variables — are in
[`SETUP_GUIDE.md`](SETUP_GUIDE.md). In short:

```powershell
# 1. Install (once). The ML step downloads ~1-2 GB.
npm run install:all
cd ml-service; python -m venv .venv; .venv\Scripts\python.exe -m pip install -r requirements.txt; cd ..

# 2. Start Neo4j (Neo4j Desktop or a service), then set backend\.env
#    (NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD).

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
