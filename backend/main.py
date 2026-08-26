from backend.routers import assistant, components, dashboard, detections, scans
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from backend.database import initialize_database
from backend.routers import testing

initialize_database()

app = FastAPI(
    title="CircuitLoop Backend",
    version="1.0.0",
    description="Backend API for PCB component detection and testing.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    status_code = 400 if request.url.path.startswith("/api/detections") or request.url.path.endswith("/test") else 422
    return JSONResponse(status_code=status_code, content={"detail": jsonable_encoder(exc.errors())})


@app.get("/", tags=["Health"], summary="List CircuitLoop API endpoints")
def home():
    return {
        "service": "CircuitLoop Backend",
        "endpoints": [
            "GET /api/health",
            "POST /api/scans",
            "GET /api/scans",
            "GET /api/scans/{scan_id}",
            "POST /api/components",
            "GET /api/components",
            "GET /api/components/{component_id}",
            "PUT /api/components/{component_id}",
            "DELETE /api/components/{component_id}",
            "POST /api/detections",
            "POST /api/components/{component_id}/test",
            "GET /api/components/{component_id}/test-result",
            "GET /api/dashboard/stats",
            "POST /api/assistant",
        ],
    }


@app.get("/api/health", tags=["Health"], summary="Check backend health")
def health():
    return {"status": "ok", "service": "CircuitLoop Backend"}


app.include_router(scans.router)
app.include_router(components.router)
app.include_router(detections.router)
app.include_router(testing.router)
app.include_router(dashboard.router)
app.include_router(assistant.router)


def run():
    import uvicorn

    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=True)
