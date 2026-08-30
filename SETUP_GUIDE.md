# CircuitLoop — Setup Guide

CircuitLoop finds electronic components in a photo of a circuit board, reads
their printed markings, and saves them to a database so you can browse and
test them.

Follow the steps in order. Commands are written for **Windows PowerShell**.

---

## What you are setting up

CircuitLoop is four programs that run at the same time:

| Part | What it does | Address |
|---|---|---|
| **Neo4j** | The database | `localhost:7687` |
| **ML service** (Python) | Detects components in the image, reads text | `127.0.0.1:8001` |
| **Backend** (Node.js) | The API — connects everything together | `127.0.0.1:8000` |
| **Frontend** (React) | The web page you use | `localhost:5173` |

The frontend talks only to the backend. The backend talks to the database and
the ML service.

> **Note:** ESP32 / hardware testing is **not built yet**. There is no firmware
> or serial code in this project, so there is nothing to set up for it.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Get the code](#2-get-the-code)
3. [Set up the database](#3-set-up-the-database)
4. [Set up environment variables](#4-set-up-environment-variables)
5. [Install dependencies](#5-install-dependencies)
6. [Run the project](#6-run-the-project)
7. [Check that it works](#7-check-that-it-works)
8. [Command reference](#8-command-reference)
9. [If something goes wrong](#9-if-something-goes-wrong)

---

## 1. Prerequisites

Install these first. Run each check command to confirm it worked.

| Software | Version needed | Check it |
|---|---|---|
| **Git** | any | `git --version` |
| **Node.js** | 20.19 or newer (22.13+ recommended) | `node --version` |
| **Python** | 3.11 or newer | `python --version` |
| **Neo4j** | any recent 5.x, Community Edition | open <http://localhost:7474> after installing |

Where to get them:

- **Node.js** — <https://nodejs.org/>
- **Python** — <https://www.python.org/downloads/> (tick "Add Python to PATH")
- **Neo4j** — <https://neo4j.com/download/> (Neo4j Desktop is the easiest option)

**A Gemini API key is required for component detection** — get one at <https://aistudio.google.com/apikey> and set `GEMINI_API_KEY` in `ml-service/.env` (see step 4). There is no local fallback model, so without it `/detect` returns an error.

**Internet:** the first time you start the ML service it downloads a small
text-embedding model. After that it works offline.

---

## 2. Get the code

```powershell
git clone <repository-url> CircuitLoop
cd CircuitLoop
```

You should now have three folders: `frontend`, `backend`, and `ml-service`.

---

## 3. Set up the database

**Step 3.1 — Install and start Neo4j.**

Using Neo4j Desktop:
1. Open Neo4j Desktop.
2. Create a new **Local DBMS**.
3. Set a password and write it down — you need it in the next step.
4. Click **Start**.

**Step 3.2 — Confirm it is running.**

Open <http://localhost:7474> in your browser. The Neo4j Browser should load and
let you log in with user `neo4j` and your password.

**Step 3.3 — That is all.**

You do **not** need to create tables, run a migration, or import anything.
The backend creates everything it needs automatically the first time you start
it (step 6).

---

## 4. Set up environment variables

Each service has an example file. Copy it, then fill in the values.

**Step 4.1 — Backend (required).**

```powershell
cd backend
Copy-Item .env.example .env
notepad .env
```

Fill in these three lines and save:

```dotenv
NEO4J_URI=neo4j://127.0.0.1:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password-here
```

Everything else in the file is optional — leave it blank.

The backend **will not start** if these three are missing or empty.

**Step 4.2 — ML service (required).**

The ML service needs its own `.env`, because Neo4j now stores the RAG datasheet
corpus and serves the vector similarity search. Use **the same three values**
you just put in `backend/.env` — both processes talk to the same database.

```powershell
cd ..\ml-service
Copy-Item .env.example .env
notepad .env
```

```dotenv
NEO4J_URI=neo4j://127.0.0.1:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password-here
```

The ML service **will not start** if these three are missing or empty.

Add your Gemini key in the same file to enable component detection:

```dotenv
GEMINI_API_KEY=your-key-here
```

Gemini is the only detector — it analyses the uploaded image, classifies the
components, and reads their printed markings itself, all in one call. There is
no local fallback model: the ML service still starts without a key (so
`/search` keeps working for the assistant), but `/detect` returns an error
until one is set.

**Step 4.3 — Frontend (optional).**

Skip this unless you changed the backend's port. If you did:

```powershell
cd ..\frontend
Copy-Item .env.example .env.local
notepad .env.local
```

```dotenv
VITE_API_URL=http://127.0.0.1:8000
```

### Optional backend settings

Only add these to `backend/.env` if you need them.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8000` | Port the backend listens on |
| `GEMINI_API_KEY` | none | **Primary** AI provider for the Assistant page. Get a key at <https://aistudio.google.com/apikey>. Falls back to Groq if unset or if a request fails |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Change the Gemini model without editing code |
| `GROQ_API_KEY` | none | **Fallback** AI provider, used only when Gemini fails. Get a key at <https://console.groq.com>. With neither key set, the Assistant shows a "temporarily unavailable" message |
| `ML_SERVICE_URL` | `http://127.0.0.1:8001` | Where the ML service is |
| `CIRCUITLOOP_CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Which web addresses may call the API |
| `CIRCUITLOOP_MAX_UPLOAD_BYTES` | `10485760` (10 MB) | Largest image you can upload |

---

## 5. Install dependencies

Run these from the project **root** folder (the one containing `frontend`,
`backend`, and `ml-service`).

**Step 5.1 — Node dependencies (root, backend, frontend).**

```powershell
npm run install:all
```

This installs the small root helper that runs everything together (step 6),
then the backend and frontend packages. (If you prefer, you can still run
`npm install` in each of `.`, `backend`, and `frontend` by hand.)

**Step 5.2 — ML service (Python).**

This one is large (about 1–2 GB) and takes several minutes.

```powershell
cd ml-service
python -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt
cd ..
```

The AI model file and search index are already included in the project. There
is nothing extra to download or train.

---

## 6. Run the project

Make sure **Neo4j is running first** (step 3). Then, from the project **root**:

```powershell
npm run dev
```

This starts all three services in one terminal, with labelled output:

| Label | Service | Address |
|---|---|---|
| `[ml]` | ML service (Python) | `127.0.0.1:8001` |
| `[backend]` | Backend (Node.js) | `127.0.0.1:8000` |
| `[frontend]` | Frontend (Vite) | `localhost:5173` |

The ML service takes ~15–25 s to load its models. **The frontend deliberately
waits for it** — so the moment Vite prints its address, the whole stack can
actually serve a scan. Watch for:

```
[ml]       ... Search service ready.
[ml]       ✅ ML SERVICE READY — models loaded, scanning available (20s)
[frontend] ✅ ML service ready — models + index loaded
[frontend]   ➜  Local:   http://localhost:5173/
```

**Then open <http://localhost:5173> in your browser.**

Press `Ctrl+C` once to stop all three. (If a previous run left processes behind,
`npm run dev` will fail on a port already in use — close the old terminals or
kill whatever is on 8000 / 8001 / 5173 first; see
[Port already in use](#port-already-in-use).)

> If `npm run dev` reports **"ML service virtualenv not found"**, you skipped
> [step 5.2](#5-install-dependencies) — create the venv, then re-run.

### Alternative: separate terminals

If you'd rather see each service in its own window (started in this order):

```powershell
# Terminal 1 — ML service
cd C:\path\to\CircuitLoop\ml-service
.venv\Scripts\python.exe app.py

# Terminal 2 — Backend
cd C:\path\to\CircuitLoop\backend
npm run dev

# Terminal 3 — Frontend
cd C:\path\to\CircuitLoop\frontend
npm run dev
```

---

## 7. Check that it works

Go through this list in order.

1. **Neo4j is running** — <http://localhost:7474> loads.
2. **ML service is healthy** — run:
   ```powershell
   Invoke-RestMethod http://127.0.0.1:8001/health
   ```
   You should see `status=ok`, `model_loaded=True`, `index_loaded=True`.
3. **Backend is running** — run:
   ```powershell
   Invoke-RestMethod http://127.0.0.1:8000/api/health
   ```
   You should see `status=ok`.
4. **Backend can reach the database** — run:
   ```powershell
   Invoke-RestMethod http://127.0.0.1:8000/api/dashboard/stats
   ```
   You should see a list of numbers. All zeros is correct on a new database.
5. **The website loads** — <http://localhost:5173> shows the CircuitLoop page
   with a menu on the left.
6. **Scanning works** — go to **Scan PCB**, upload a photo of a circuit board
   (PNG or JPEG, under 10 MB). You should be taken to the **Analysis** page
   with detected components listed.
7. **Data is saved** — open <http://localhost:7474> and run:
   ```cypher
   MATCH (s:Scan)-[:DETECTED]->(c:Component)
   RETURN s.id, c.type, c.name, c.confidence LIMIT 25;
   ```
   You should see the same components the website showed.

**Two things that look like errors but are normal:**

- Many components have **no name**. Most components have no readable printed
  text. This is expected.
- The **Testing** page says "ESP32 testing station — Not yet implemented".
  That feature does not exist yet.

---

## 8. Command reference

### Start services

```powershell
# All three at once, from the project root (Neo4j must already be running)
npm run dev

# …or one at a time
npm run dev:ml         # ML service   (wraps ml-service/.venv + app.py)
npm run dev:backend    # backend
npm run dev:frontend   # frontend
```

The `npm run dev:*` scripts just call into each sub-project — the individual
commands from [the alternative in step 6](#alternative-separate-terminals)
still work if you prefer.

### Build for production

```powershell
cd backend
npm run build      # creates backend/dist
npm start          # runs the built version

cd frontend
npm run build      # creates frontend/dist
npm run preview    # preview the built site
```

### Run tests

```powershell
npm test           # backend tests (from the root); DB tests skip if Neo4j is off

cd ml-service
.venv\Scripts\python.exe -m pytest
```

### Check what is using a port

```powershell
netstat -ano | findstr "5173 8000 8001 7474 7687"
Stop-Process -Id <PID>
```

### Look at the database

Open <http://localhost:7474> and run:

```cypher
MATCH (n) RETURN labels(n) AS label, count(*) AS count;
```

To check the RAG datasheet corpus and its vector index specifically:

```cypher
MATCH (d:DatasheetChunk)
RETURN count(d) AS chunks,
       count(d.embedding) AS with_embedding,
       count(DISTINCT d.sourceFile) AS datasheets;

SHOW INDEXES YIELD name, type, state
WHERE name = 'datasheet_chunk_embedding_index'
RETURN name, type, state;
```

If `chunks` is 0, the corpus has not been loaded yet — see
[`ml-service/README.md`](ml-service/README.md#rag-corpus-neo4j), or run:

```powershell
cd ml-service; .venv\Scripts\python.exe pipeline/ingest.py
```

---

## 9. If something goes wrong

### Backend says "Missing required Neo4j environment variable(s)"

The file `backend/.env` is missing, or `NEO4J_URI` / `NEO4J_USER` /
`NEO4J_PASSWORD` are empty. Redo [step 4.1](#4-set-up-environment-variables).
The file must be inside the `backend` folder, not the project root.

### Backend says "Neo4j authentication failed"

Wrong username or password in `backend/.env`. On a brand-new Neo4j install you
must change the starting password (`neo4j` / `neo4j`) in the Neo4j Browser
first.

### Backend says "Could not reach Neo4j"

Neo4j is not running, or the address is wrong. Start Neo4j and confirm
<http://localhost:7474> loads.

### Uploading an image fails with "Analysis failed" / "ML service unreachable"

The ML service (`127.0.0.1:8001`) is not running or has not finished loading —
it is a separate process that `npm run dev` starts as `[ml]`, and it needs
~15–25 s to load its models. Most common causes:

1. **You scanned before it was ready.** With `npm run dev` the frontend waits
   for the ML service, so if you opened <http://localhost:5173> the moment Vite
   printed it, you are fine — otherwise wait for
   `[ml] ✅ ML SERVICE READY` and retry the scan.
2. **Stale processes from an earlier run.** If you started `npm run dev` while an
   old backend/frontend was still running, the old one (with no ML service)
   keeps serving your browser. Close every old dev terminal, kill anything left
   on 8000 / 8001 / 5173 (see [Port already in use](#port-already-in-use)), then
   run `npm run dev` once from the repo root.
3. **The venv is missing** — `npm run dev` prints "ML service virtualenv not
   found"; do [step 5.2](#5-install-dependencies).

Check the service directly:

```powershell
Invoke-RestMethod http://127.0.0.1:8001/health   # status=ok, model_loaded=True, index_loaded=True
```

### The website says "Could not reach the server"

1. Is the backend running? Test with
   `Invoke-RestMethod http://127.0.0.1:8000/api/health`
2. Did the frontend open on a port other than 5173? If Vite printed a different
   port, add it to `CIRCUITLOOP_CORS_ORIGINS` in `backend/.env` and restart the
   backend.

### Python says "No module named fastapi" (or neo4j, sentence_transformers...)

You are using the wrong Python. Always run `.venv\Scripts\python.exe`, not
plain `python`.

### PowerShell blocks the Python activation script

You do not need to activate the environment — just use
`.venv\Scripts\python.exe` for every command.

### I changed a setting and nothing happened

Restart the service. `.env` files are only read at startup:

| Changed | Do this |
|---|---|
| `backend/.env` | Restart the backend |
| `ml-service/.env` | Restart the ML service |
| `frontend/.env.local` | Restart the frontend |
| Backend or frontend source code | Reloads by itself |
| `ml-service` Python code | Restart the ML service |

### Port already in use

Usually a dev process from an earlier run that was never stopped. Find and kill
whatever holds each port, then start `npm run dev` once:

```powershell
foreach ($p in 8000,8001,5173) {
  Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
}
```

Or change the port: `PORT` for the backend, `ML_SERVICE_PORT` for the ML
service. If you change one, update `VITE_API_URL` (frontend) or
`ML_SERVICE_URL` (backend) to match.
