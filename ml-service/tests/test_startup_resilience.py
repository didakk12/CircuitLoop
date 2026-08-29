"""
Startup must not depend on any detection model loading.

Detection's primary stage (Gemini) needs no local checkpoint, so a missing or
corrupt `.pt` has to degrade the fallback stage rather than take the whole
service — and the working primary — down with it. This reverses the earlier
"fail fast on a broken model" convention for detectors only; Neo4j stays
fail-fast because nothing else can serve `/search`.

These tests drive the real `lifespan` against a THROWAWAY FastAPI instance
rather than the module-level `app`. That matters: the lifespan writes the
loaded services onto the app it is given and closes its own search service on
exit, so running it against the shared `app` would leave the session-scoped
`client` fixture holding broken state. They depend on Neo4j for the same
reason `client` does.

The request-path counterpart — Gemini serving a real `/detect` call while no
YOLO model is loaded — lives in test_detect.py, where it can use the already
running app.
"""

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app as app_module
from detection import SOURCE_CIRCUITLOOP, SOURCE_HF, DetectionService


class _UnloadableDetectionService(DetectionService):
    """A checkpoint that cannot be read, without touching the real files."""

    def load(self) -> None:
        raise FileNotFoundError(f"YOLO model weights not found at {self.model_path}")


@pytest.fixture
def started_state(neo4j_settings, monkeypatch):
    """Runs the real lifespan on a throwaway app and yields its state.

    Every local YOLO checkpoint is made unloadable first, so what this
    exercises is precisely the "no detection model would load" startup.
    """
    monkeypatch.setattr(app_module, "DetectionService", _UnloadableDetectionService)
    throwaway = FastAPI(lifespan=app_module.lifespan)

    with TestClient(throwaway):
        yield throwaway.state


def test_startup_succeeds_when_no_yolo_checkpoint_loads(started_state):
    # Reaching this line at all is the assertion: the lifespan completed
    # instead of raising FileNotFoundError.
    assert started_state.detection_service.is_loaded is False
    assert started_state.hf_detection_service is None


def test_the_rag_store_still_comes_up_when_no_detector_does(started_state):
    """A detector failing must not take the unrelated /search path with it."""
    assert started_state.search_service.is_loaded


def test_a_normal_startup_still_loads_the_custom_model(client):
    """The counterpart to the tests above: tolerating a load failure must not
    mean the project's own model quietly stopped being loaded. It is still
    read at every normal startup and is still half of the fallback stage."""
    detection_service = client.app.state.detection_service

    assert detection_service.is_loaded
    assert detection_service.source == SOURCE_CIRCUITLOOP
    assert Path(detection_service.model_path).name == "pcb_yolo11s_best.pt"
    assert client.app.state.hf_detection_service.source == SOURCE_HF


def test_health_reports_each_stage_separately(client):
    health = client.get("/health").json()

    # `model_loaded` now means "some stage can serve", not "the one YOLO model
    # loaded" — which is the fact a caller actually needs now that detection
    # has two independent stages.
    assert health["model_loaded"] is True
    assert health["custom_model_loaded"] is True
    assert health["hf_model_loaded"] is True
    assert isinstance(health["gemini_configured"], bool)
