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


@pytest.fixture
def fresh_started_state(neo4j_settings):
    """Runs the real, unpatched lifespan on its own throwaway app.

    Unlike the shared session-scoped `client` fixture, nothing else in the
    suite can have already exercised this app's fallback path and lazily
    loaded its `detection_service`/`hf_detection_service` — so a test using
    this fixture can assert their "just started" state deterministically,
    regardless of what other tests (in this file or any other) have done to
    the shared `client`'s state.
    """
    throwaway = FastAPI(lifespan=app_module.lifespan)

    with TestClient(throwaway):
        yield throwaway.state


def test_startup_succeeds_when_no_yolo_checkpoint_loads(started_state):
    # Reaching this line at all is the assertion: the lifespan completed
    # instead of raising FileNotFoundError. Both services exist (lazy loading
    # constructs them unconditionally) but neither has loaded anything yet —
    # startup no longer attempts to load either one at all.
    assert started_state.detection_service.is_loaded is False
    assert started_state.hf_detection_service.is_loaded is False

    # And the unloadable checkpoint stays gracefully unavailable once it IS
    # actually asked to load, rather than raising out of the request path.
    started_state.detection_service.ensure_loaded()
    started_state.hf_detection_service.ensure_loaded()
    assert started_state.detection_service.is_loaded is False
    assert started_state.hf_detection_service.is_loaded is False


def test_the_rag_store_still_comes_up_when_no_detector_does(started_state):
    """A detector failing must not take the unrelated /search path with it."""
    assert started_state.search_service.is_loaded


def test_a_normal_startup_does_not_eagerly_load_the_custom_model(fresh_started_state):
    """A normal startup constructs both YOLO services — they exist, and are
    still half of the fallback stage — but does not pay to load either one
    until the fallback stage is actually reached. Loading two YOLO checkpoints
    before it's known whether Gemini will ever fail is pure startup-time
    memory/time waste on a deployment where Gemini is configured and serving
    every request."""
    detection_service = fresh_started_state.detection_service

    assert detection_service.is_loaded is False
    assert detection_service.source == SOURCE_CIRCUITLOOP
    assert Path(detection_service.model_path).name == "pcb_yolo11s_best.pt"
    assert fresh_started_state.hf_detection_service.source == SOURCE_HF
    assert fresh_started_state.hf_detection_service.is_loaded is False


def test_the_custom_model_loads_on_first_use_and_then_stays_loaded():
    """The lazy counterpart to the test above: the model that doesn't load at
    startup does load — and only needs to once — the first time it's asked
    to serve a detection.

    Uses its own throwaway instance rather than the shared session-scoped
    `client`'s state, so triggering a real load here has no lasting effect on
    later tests that assume an unloaded starting point."""
    detection_service = DetectionService()
    assert detection_service.is_loaded is False

    detection_service.ensure_loaded()
    assert detection_service.is_loaded is True

    # A second call must not re-load (and must not raise) now that it's warm.
    detection_service.ensure_loaded()
    assert detection_service.is_loaded is True


def test_health_reports_each_stage_separately(client):
    health = client.get("/health").json()

    # `model_loaded` now means "some stage can serve", not "the one YOLO model
    # loaded" — which is the fact a caller actually needs now that detection
    # has two independent stages. Both YOLO stages report unloaded here
    # because nothing has triggered the fallback path yet in this test — that
    # is the whole point of loading them lazily rather than at startup.
    assert isinstance(health["model_loaded"], bool)
    assert isinstance(health["custom_model_loaded"], bool)
    assert isinstance(health["hf_model_loaded"], bool)
    assert isinstance(health["gemini_configured"], bool)
