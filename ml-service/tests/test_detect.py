"""
POST /detect — exercised against a stubbed Gemini detector (session-scoped
`client`/`sample_image_bytes` fixtures), plus invalid-input and error-path
cases per §9 Phase 6's explicit requirements: invalid requests, malformed
images, detection response validation, service errors.

Gemini is the only detector this service runs — there is no local fallback
stage. Every test here pins `app.state.gemini_detection_service` explicitly
rather than depending on whether a real key is present in `ml-service/.env`,
and no test makes a real Gemini call.
"""

import dataclasses
from pathlib import Path

import pytest

import app as app_module
from detection_types import BoundingBox, Detection
from gemini_detection import SOURCE_GEMINI, GeminiUnavailableError


class _StubGemini:
    """Stands in for GeminiDetectionService with the same public surface.

    `calls` records every invocation so a test can assert it really was (or
    wasn't) used.
    """

    def __init__(self, detections=None, error=None):
        self._detections = detections or []
        self._error = error
        self.calls = 0

    @property
    def source(self) -> str:
        return SOURCE_GEMINI

    @property
    def is_loaded(self) -> bool:
        return True

    @property
    def model_path(self) -> Path:
        return Path("gemini-3.5-flash-lite")

    @property
    def class_names(self) -> dict[int, str]:
        return {0: "resistor", 1: "capacitor"}

    def detect(self, image_bytes, confidence=0.25):
        self.calls += 1
        if self._error is not None:
            raise self._error
        return list(self._detections)


def _gemini_detection() -> Detection:
    return Detection(
        class_id=0,
        class_name="resistor",
        confidence=0.9,
        bbox=BoundingBox(x1=10, y1=20, x2=60, y2=70),
        text="10K",
        source=SOURCE_GEMINI,
    )


# --- Gemini serving --------------------------------------------------------


def test_detect_is_served_by_gemini_when_it_is_available(client, sample_image_bytes, monkeypatch):
    stub = _StubGemini(detections=[_gemini_detection()])
    monkeypatch.setattr(client.app.state, "gemini_detection_service", stub)

    response = client.post("/detect", files={"image": ("hero.png", sample_image_bytes, "image/png")})

    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "gemini"
    assert stub.calls == 1
    assert body["detections"] == [
        {
            "class_name": "resistor",
            "confidence": 0.9,
            "bbox": {"x1": 10, "y1": 20, "x2": 60, "y2": 70},
            "text": "10K",
        }
    ]


def test_detect_returns_503_when_gemini_is_unavailable(client, sample_image_bytes, monkeypatch):
    stub = _StubGemini(error=GeminiUnavailableError("Gemini returned HTTP 503"))
    monkeypatch.setattr(client.app.state, "gemini_detection_service", stub)

    response = client.post(
        "/detect",
        files={"image": ("hero.png", sample_image_bytes, "image/png")},
        data={"confidence": "0.01"},
    )

    assert response.status_code == 503
    assert response.json()["error"] == "service_unavailable"
    assert stub.calls == 1


def test_detect_returns_503_when_gemini_is_not_configured(client, sample_image_bytes, monkeypatch):
    monkeypatch.setattr(client.app.state, "gemini_detection_service", None)

    response = client.post("/detect", files={"image": ("hero.png", sample_image_bytes, "image/png")})

    assert response.status_code == 503
    assert response.json()["error"] == "service_unavailable"


# --- Input validation -------------------------------------------------------


def test_detect_missing_image_field_returns_422(client):
    response = client.post("/detect", data={"confidence": "0.25"})

    assert response.status_code == 422
    assert response.json()["error"] == "validation_error"


def test_detect_wrong_content_type_returns_415(client):
    response = client.post("/detect", files={"image": ("x.txt", b"not an image", "text/plain")})

    assert response.status_code == 415
    assert response.json()["error"] == "unsupported_media_type"


def test_detect_malformed_image_bytes_returns_400(client):
    """A file claiming to be a PNG whose bytes don't actually decode as one."""
    response = client.post("/detect", files={"image": ("x.png", b"this is not real png data", "image/png")})

    assert response.status_code == 400
    assert response.json()["error"] == "invalid_image"


def test_detect_malformed_image_is_a_400_even_when_gemini_would_have_served(
    client, monkeypatch
):
    """An undecodable upload is a client error: Gemini reports it as a
    ValueError and it must surface as a 400, not a 503, whether or not
    Gemini itself is configured to serve."""
    stub = _StubGemini(error=ValueError("Could not decode image bytes"))
    monkeypatch.setattr(client.app.state, "gemini_detection_service", stub)

    response = client.post("/detect", files={"image": ("x.png", b"not real png", "image/png")})

    assert response.status_code == 400
    assert response.json()["error"] == "invalid_image"


def test_detect_empty_image_returns_400(client):
    response = client.post("/detect", files={"image": ("x.png", b"", "image/png")})

    assert response.status_code == 400
    assert response.json()["error"] == "invalid_image"


def test_detect_oversized_image_returns_413(client, sample_image_bytes, monkeypatch):
    # Settings is a frozen dataclass — replace the module-level reference
    # app.py actually uses (`from config import settings`), not an attribute
    # on the frozen instance itself.
    tiny_limit_settings = dataclasses.replace(app_module.settings, max_image_bytes=100)
    monkeypatch.setattr(app_module, "settings", tiny_limit_settings)

    response = client.post("/detect", files={"image": ("hero.png", sample_image_bytes, "image/png")})

    assert response.status_code == 413
    assert response.json()["error"] == "payload_too_large"
