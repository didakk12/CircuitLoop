"""
Minimal typed configuration for the ML service, read from environment
variables — same principle as `backend/src/config/env.ts` on the TS side
(no secrets hardcoded), scaled down to what this service actually needs:
no credentials exist here yet (no Neo4j access, no LLM key — see
ML_SERVICE_INTEGRATION_PLAN.md §6/§7 for why), just non-secret runtime
knobs, so everything has a safe default and `.env` is optional rather than
required.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()  # loads ml-service/.env if present; safe no-op otherwise

# Deliberately localhost-only by default — this service is never meant to
# be reachable from the browser or the network (ML_SERVICE_INTEGRATION_PLAN.md §8).
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8001  # distinct from the TS backend's 8000
DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10MB, matches the limit planned for the TS-side upload endpoint


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    max_image_bytes: int


def load_settings() -> Settings:
    return Settings(
        host=os.getenv("ML_SERVICE_HOST", DEFAULT_HOST),
        port=int(os.getenv("ML_SERVICE_PORT", str(DEFAULT_PORT))),
        max_image_bytes=int(os.getenv("ML_SERVICE_MAX_IMAGE_BYTES", str(DEFAULT_MAX_IMAGE_BYTES))),
    )


settings = load_settings()
