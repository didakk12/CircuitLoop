"""
Minimal typed configuration for the ML service, read from environment
variables -- same principle as `backend/src/config/env.ts` on the TS side
(no secrets hardcoded), scaled to what this service actually needs.

Two groups of settings live here:

  - Non-secret runtime knobs (host, port, upload limit). Everything has a
    safe default, so `.env` stays optional for these.

  - Neo4j connection settings. These are **required** now that Neo4j is the
    RAG store and vector index (see neo4j_store.py). They are read from the
    environment only, never hardcoded, and `ml-service/.env` is git-ignored
    exactly like `backend/.env`. `load_neo4j_settings()` returns None rather
    than raising when they are absent, so `ingest.py` and the tests can print
    a clear "not configured" message instead of a stack trace; `app.py` turns
    that None into a fail-fast startup error.

  - Gemini settings for the primary detector (gemini_detection.py). The API
    key is a secret and lives only in the git-ignored `.env`, never in code.
    `load_gemini_settings()` returns None when unconfigured rather than
    raising: unlike Neo4j this is NOT fail-fast, because detection still has
    the combined YOLO fallback stage to fall back to.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Explicit path rather than dotenv's frame-walking discovery, so the values
# load identically whether the service is started from ml-service/, from the
# repo root (npm run dev), or by pytest.
load_dotenv(Path(__file__).resolve().parent / ".env")

# Deliberately localhost-only by default -- this service is never meant to
# be reachable from the browser or the network (ML_SERVICE_INTEGRATION_PLAN.md section 8).
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8001  # distinct from the TS backend's 8000
DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10MB, matches the TS-side upload limit

# Verified against the live API at implementation time: `gemini-2.5-flash-lite`
# returns 404 "no longer available to new users" and names this as its
# replacement. Overridable via GEMINI_MODEL so the model can be changed
# without touching code.
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
# Measured: a dense PCB photo takes ~6s end to end, but tail latency has been
# observed past 30s. Since a timeout silently demotes the request to the YOLO
# fallback, the ceiling is set well above the typical case rather than close
# to it.
DEFAULT_GEMINI_TIMEOUT_S = 60.0


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    max_image_bytes: int


@dataclass(frozen=True)
class Neo4jSettings:
    """Connection settings for the RAG store. Never logged or echoed --
    `neo4j_store.redact_uri()` is used for any log line naming the target."""

    uri: str
    username: str
    password: str
    # Optional named database within the DBMS; None uses the server default.
    database: str | None


@dataclass(frozen=True)
class GeminiSettings:
    """Configuration for the primary (Gemini) detector. `api_key` is a secret:
    it is sent only as the Gemini request's own header and is never logged."""

    api_key: str
    model: str
    timeout_s: float


def load_settings() -> Settings:
    return Settings(
        host=os.getenv("ML_SERVICE_HOST", DEFAULT_HOST),
        port=int(os.getenv("ML_SERVICE_PORT", str(DEFAULT_PORT))),
        max_image_bytes=int(os.getenv("ML_SERVICE_MAX_IMAGE_BYTES", str(DEFAULT_MAX_IMAGE_BYTES))),
    )


def load_neo4j_settings() -> Neo4jSettings | None:
    """Reads the Neo4j connection settings, or returns None if any required
    one is missing. Treats an empty string as unset, matching
    `backend/src/config/env.ts::readEnv`."""

    def read(name: str) -> str | None:
        value = os.getenv(name)
        return None if value is None or value == "" else value

    uri = read("NEO4J_URI")
    username = read("NEO4J_USER")
    password = read("NEO4J_PASSWORD")
    if uri is None or username is None or password is None:
        return None

    return Neo4jSettings(
        uri=uri,
        username=username,
        password=password,
        database=read("NEO4J_DATABASE"),
    )


def load_gemini_settings() -> GeminiSettings | None:
    """Reads the Gemini detector's settings, or returns None when the API key
    is absent. Deliberately not fail-fast, unlike `load_neo4j_settings()`'s
    caller: an unconfigured key means detection runs on the combined YOLO
    fallback stage, which is a degraded but working service."""
    api_key = os.getenv("GEMINI_API_KEY")
    if api_key is None or api_key == "":
        return None

    return GeminiSettings(
        api_key=api_key,
        model=os.getenv("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL,
        timeout_s=float(os.getenv("GEMINI_TIMEOUT_S", str(DEFAULT_GEMINI_TIMEOUT_S))),
    )


MISSING_GEMINI_MESSAGE = (
    "GEMINI_API_KEY is not set — the primary Gemini detector is disabled and every "
    "/detect request will use the combined YOLO fallback stage. Copy "
    "ml-service/.env.example to ml-service/.env and set GEMINI_API_KEY to enable it."
)

MISSING_NEO4J_MESSAGE = (
    "Neo4j is not configured for the ML service. Copy ml-service/.env.example to "
    "ml-service/.env and set NEO4J_URI, NEO4J_USER and NEO4J_PASSWORD to the same "
    "values backend/.env already uses -- Neo4j is the RAG store and vector index."
)

settings = load_settings()
