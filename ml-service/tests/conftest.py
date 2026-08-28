"""
Shared fixtures for ml-service's pytest suite. `client` uses the real
FastAPI app with its real lifespan (real YOLO model + real FAISS index
loaded once, session-scoped) — these tests exercise the actual trained
model and actual indexed data, not mocks, per §9 Phase 6's explicit intent.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import app

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def sample_image_bytes() -> bytes:
    """A real image file already in the repo — not a synthetic PCB photo,
    but real, decodable image bytes suitable for exercising the full
    decode -> YOLO -> OCR pipeline. See ml-service/README.md for why a real
    PCB test photo isn't available in this repo."""
    image_path = PROJECT_ROOT / "frontend" / "src" / "assets" / "hero.png"
    return image_path.read_bytes()
