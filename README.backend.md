# CircuitLoop Backend

CircuitLoop is a FastAPI backend for detecting, storing, and testing PCB components. A camera/CV service creates a scan, sends YOLO/OCR detections, and a React dashboard reads the resulting components and test status.

## Run locally

```powershell
uv sync
uv run uvicorn main:app --reload
```

The API and Swagger UI are available at `http://127.0.0.1:8000` and `/docs`. The default database is `circuitloop.db` in the project root. Set `CIRCUITLOOP_DATABASE_URL` to use another SQLite URL.

## API

- `GET /api/health` checks service health.
- `POST /api/scans`, `GET /api/scans`, and `GET /api/scans/{scan_id}` manage scans.
- `POST /api/detections` stores a validated batch of CV detections for a scan.
- `POST`, `GET`, `GET /{id}`, `PUT /{id}`, and `DELETE /{id}` under `/api/components` manage components.
- `POST /api/components/{id}/test` records a physical test; `GET /api/components/{id}/test-result` returns the latest result.
- `GET /api/dashboard/stats` returns scan, component, test, and confidence statistics.
- `POST /api/assistant` is the future AI/RAG boundary. Until configured, it explicitly returns `AI assistant is not configured yet.`

The CV teammate can send:

```json
{
	"scan_id": 1,
	"detections": [
		{
			"type": "resistor",
			"name": "R1",
			"confidence": 0.94,
			"bbox": {"x1": 120, "y1": 80, "x2": 180, "y2": 130}
		}
	]
}
```

## Database

SQLAlchemy manages `scans`, `components`, and `test_results`. Scans have many components; components have many test results. Existing component tables are extended in place at startup when the new columns are missing.

## React integration

CORS allows `localhost` and `127.0.0.1` on ports `3000` and `5173`. The frontend can list/filter `/api/components`, open a component detail response with `test_results`, submit a test, and refresh `/api/dashboard/stats`.

## Tests

```powershell
uv run pytest
```

Tests use a temporary SQLite database and do not require YOLO, OCR, an external AI service, or any other external service.

## Future AI/RAG integration

The assistant service receives a component ID and question. A future implementation can load the component, OCR metadata, test history, and retrieved datasheets before calling an agent. No LLM is claimed to be connected today; configure `CIRCUITLOOP_AI_API_KEY` only when the real provider integration is implemented.
