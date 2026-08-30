"""
Shared fixtures for ml-service's pytest suite.

`client` uses the real FastAPI app with its real lifespan (real embedding
model, real Neo4j vector index, session-scoped) — these tests exercise the
actual indexed corpus, not mocks, per ML_SERVICE_INTEGRATION_PLAN.md §9
Phase 6's explicit intent. Detection itself (Gemini) is stubbed per-test
where exercised, since it's the one dependency that would otherwise need a
real API key and a real network call.

Neo4j is now a hard dependency of the service (it is the RAG store and vector
index), so the app cannot start without it. Rather than let that surface as a
confusing lifespan crash, `neo4j_settings` skips the affected tests with a
clear reason when Neo4j is unconfigured or unreachable — the same convention
the TypeScript suite already uses ("DB tests skip if Neo4j is off").
"""

import sys
from pathlib import Path

import pytest

ML_SERVICE_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = ML_SERVICE_ROOT.parent
sys.path.insert(0, str(ML_SERVICE_ROOT))

from config import load_neo4j_settings  # noqa: E402
from neo4j_store import RagStore  # noqa: E402


@pytest.fixture(scope="session")
def neo4j_settings():
    """Live Neo4j settings, or skip. Verifies reachability once per session so
    an unreachable database is reported as a skip, not as N failures."""
    settings = load_neo4j_settings()
    if settings is None:
        pytest.skip("Neo4j is not configured — set NEO4J_* in ml-service/.env")

    probe = RagStore(settings.uri, settings.username, settings.password, settings.database)
    try:
        probe.connect()
    except Exception as error:  # noqa: BLE001 — any connection failure means "skip", not "fail"
        pytest.skip(f"Neo4j is not reachable: {type(error).__name__}")
    finally:
        probe.close()
    return settings


@pytest.fixture(scope="session")
def rag_store(neo4j_settings):
    """Connected RagStore against the real database, for the storage/index tests."""
    store = RagStore(
        neo4j_settings.uri,
        neo4j_settings.username,
        neo4j_settings.password,
        neo4j_settings.database,
    )
    store.connect()
    store.ensure_schema()
    yield store
    store.close()


@pytest.fixture(scope="session")
def client(neo4j_settings):
    """The real app, real lifespan. Depends on `neo4j_settings` so the suite
    skips cleanly instead of failing inside the lifespan when Neo4j is off."""
    from fastapi.testclient import TestClient

    from app import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def sample_image_bytes() -> bytes:
    """A real image file already in the repo — not a synthetic PCB photo,
    but real, decodable image bytes suitable for exercising the decode step
    and the detection endpoints. See ml-service/README.md for why a real PCB
    test photo isn't available in this repo."""
    image_path = PROJECT_ROOT / "frontend" / "src" / "assets" / "hero.png"
    return image_path.read_bytes()
