"""
POST /detect — exercised against the real trained model and a real image
(session-scoped `client`/`sample_image_bytes` fixtures), plus invalid-input
and error-path cases per §9 Phase 6's explicit requirements: invalid requests,
malformed images, detection response validation, service errors.

Detection now has two stages: Gemini (primary) and the combined
custom-YOLO11s + HF-YOLOv8s fallback. Whether a real Gemini key is present in
`ml-service/.env` varies by machine, so every stage-sensitive test pins the
stage explicitly via `app.state.gemini_detection_service` rather than
depending on local configuration. No test here makes a real Gemini call.
"""

import dataclasses
from pathlib import Path

import pytest

import app as app_module
from detection import BoundingBox, Detection, DetectionService
from gemini_detection import SOURCE_GEMINI, GeminiUnavailableError

KNOWN_CLASSES = {"battery", "buzzer", "capacitor", "display", "ic", "relay", "resistor", "switch"}

HF_CLASSES = {
    "battery", "button", "buzzer", "capacitor", "clock", "connector", "diode",
    "display", "fuse", "heatsink", "ic", "inductor", "led", "pads", "pins",
    "potentiometer", "relay", "resistor", "switch", "transformer", "transistor",
}


class _StubGemini:
    """Stands in for GeminiDetectionService with the same public surface.

    `calls` records every invocation so a test can assert the primary stage
    really was (or wasn't) used.
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


@pytest.fixture
def without_gemini(client, monkeypatch):
    """Pins the request to the YOLO fallback stage, whatever the local .env says."""
    monkeypatch.setattr(client.app.state, "gemini_detection_service", None)
    return client


# --- Stage 1: Gemini, the primary detector -----------------------------------


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


def test_detect_does_not_run_the_yolo_models_while_gemini_is_serving(
    client, sample_image_bytes, monkeypatch
):
    """The fallback models must stay untouched on the happy path — they are a
    fallback, not a second opinion."""
    stub = _StubGemini(detections=[_gemini_detection()])
    monkeypatch.setattr(client.app.state, "gemini_detection_service", stub)

    def fail(*args, **kwargs):  # pragma: no cover — asserted by not being called
        raise AssertionError("a YOLO model ran while Gemini was available")

    monkeypatch.setattr(client.app.state.detection_service, "detect", fail)

    response = client.post("/detect", files={"image": ("hero.png", sample_image_bytes, "image/png")})

    assert response.status_code == 200
    assert response.json()["source"] == "gemini"


def test_detect_serves_via_gemini_even_when_no_yolo_model_is_loaded(
    client, sample_image_bytes, monkeypatch
):
    """A missing/broken checkpoint must never stop Gemini from serving."""
    stub = _StubGemini(detections=[_gemini_detection()])
    monkeypatch.setattr(client.app.state, "gemini_detection_service", stub)
    monkeypatch.setattr(client.app.state, "detection_service", DetectionService())  # unloaded
    monkeypatch.setattr(client.app.state, "hf_detection_service", None)

    response = client.post("/detect", files={"image": ("hero.png", sample_image_bytes, "image/png")})

    assert response.status_code == 200
    assert response.json()["source"] == "gemini"


# --- Stage 2: the combined YOLO fallback -------------------------------------


def test_detect_falls_back_to_the_combined_yolo_stage_when_gemini_fails(
    client, sample_image_bytes, monkeypatch
):
    stub = _StubGemini(error=GeminiUnavailableError("Gemini returned HTTP 503"))
    monkeypatch.setattr(client.app.state, "gemini_detection_service", stub)

    response = client.post(
        "/detect",
        files={"image": ("hero.png", sample_image_bytes, "image/png")},
        data={"confidence": "0.01"},
    )

    assert response.status_code == 200
    assert stub.calls == 1
    body = response.json()
    assert body["source"] == "yolo_fallback"
    assert len(body["detections"]) > 0


def test_detect_with_real_image_returns_real_validated_detections(without_gemini, sample_image_bytes):
    """The fallback stage against the real models and a real image."""
    response = without_gemini.post(
        "/detect",
        files={"image": ("hero.png", sample_image_bytes, "image/png")},
        data={"confidence": "0.01"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "yolo_fallback"
    assert len(body["detections"]) > 0

    for detection in body["detections"]:
        # Response validation: exact shape, per DetectionModel in schemas.py.
        assert set(detection.keys()) == {"class_name", "confidence", "bbox", "text"}
        assert set(detection["bbox"].keys()) == {"x1", "y1", "x2", "y2"}
        # A real, verified label from one of the two models — never a guessed
        # or invented one (see ML_SERVICE_INTEGRATION_PLAN.md).
        assert detection["class_name"] in KNOWN_CLASSES | HF_CLASSES
        assert 0.0 <= detection["confidence"] <= 1.0
        assert isinstance(detection["text"], str)


def test_detect_fallback_still_works_with_only_the_custom_model(
    client, sample_image_bytes, monkeypatch
):
    monkeypatch.setattr(client.app.state, "gemini_detection_service", None)
    monkeypatch.setattr(client.app.state, "hf_detection_service", None)

    response = client.post(
        "/detect",
        files={"image": ("hero.png", sample_image_bytes, "image/png")},
        data={"confidence": "0.01"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "yolo_fallback"
    for detection in body["detections"]:
        assert detection["class_name"] in KNOWN_CLASSES


# --- Input validation (unchanged by the staging) ------------------------------


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


def test_detect_malformed_image_is_not_retried_against_the_fallback(
    client, monkeypatch
):
    """An undecodable upload is a client error, not a reason to try another
    model: Gemini reports it as a ValueError and it must surface as a 400."""
    stub = _StubGemini(error=ValueError("Could not decode image bytes"))
    monkeypatch.setattr(client.app.state, "gemini_detection_service", stub)

    def fail(*args, **kwargs):  # pragma: no cover — asserted by not being called
        raise AssertionError("the fallback stage ran for an invalid image")

    monkeypatch.setattr(client.app.state.detection_service, "detect", fail)

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


def test_detect_returns_503_only_when_every_stage_is_unavailable(
    client, sample_image_bytes, monkeypatch
):
    """Service-error path: no Gemini and no loaded YOLO model. Simulated
    without tearing down the shared session-scoped app (monkeypatch reverts
    automatically after this test)."""
    monkeypatch.setattr(client.app.state, "gemini_detection_service", None)
    monkeypatch.setattr(client.app.state, "detection_service", DetectionService())  # unloaded
    monkeypatch.setattr(client.app.state, "hf_detection_service", None)

    response = client.post("/detect", files={"image": ("hero.png", sample_image_bytes, "image/png")})

    assert response.status_code == 503
    assert response.json()["error"] == "service_unavailable"


# --- POST /detect/compare ----------------------------------------------------
#
# Benchmarking endpoint: runs every loaded detector over one image and returns
# each model's raw detections separately. Nothing is merged or suppressed here
# — the de-duplicating merge belongs to the fallback stage alone.


def test_compare_returns_both_yolo_models_separately(client, sample_image_bytes, monkeypatch):
    monkeypatch.setattr(client.app.state, "gemini_detection_service", None)

    response = client.post(
        "/detect/compare",
        files={"image": ("hero.png", sample_image_bytes, "image/png")},
        data={"confidence": "0.25"},
    )

    assert response.status_code == 200
    models = response.json()["models"]
    assert len(models) == 2

    by_source = {m["source"]: m for m in models}
    assert set(by_source) == {"circuitloop_yolo11s", "hf_yolov8s"}

    primary, hf = by_source["circuitloop_yolo11s"], by_source["hf_yolov8s"]
    assert primary["class_count"] == 8
    assert hf["class_count"] == 21
    assert primary["model_path"] == "pcb_yolo11s_best.pt"
    assert hf["model_path"] == "pcb_yolov8s_hf_best.pt"

    # Each model's detections keep the exact DetectionModel shape, so the same
    # consumer logic works for both.
    for model in models:
        for detection in model["detections"]:
            assert set(detection.keys()) == {"class_name", "confidence", "bbox", "text"}
            assert 0.0 <= detection["confidence"] <= 1.0
            assert isinstance(detection["text"], str)

    for detection in primary["detections"]:
        assert detection["class_name"] in KNOWN_CLASSES
    for detection in hf["detections"]:
        assert detection["class_name"] in HF_CLASSES


def test_compare_includes_gemini_alongside_the_yolo_models(client, sample_image_bytes, monkeypatch):
    monkeypatch.setattr(
        client.app.state, "gemini_detection_service", _StubGemini(detections=[_gemini_detection()])
    )

    response = client.post(
        "/detect/compare",
        files={"image": ("hero.png", sample_image_bytes, "image/png")},
        data={"confidence": "0.25"},
    )

    assert response.status_code == 200
    by_source = {m["source"]: m for m in response.json()["models"]}
    assert set(by_source) == {"gemini", "circuitloop_yolo11s", "hf_yolov8s"}
    # Raw and unmerged: Gemini's box survives even though the YOLO models
    # report their own boxes over the same image.
    assert by_source["gemini"]["detections"][0]["class_name"] == "resistor"


def test_compare_still_reports_the_other_models_when_gemini_is_unreachable(
    client, sample_image_bytes, monkeypatch
):
    monkeypatch.setattr(
        client.app.state,
        "gemini_detection_service",
        _StubGemini(error=GeminiUnavailableError("Gemini request failed: ConnectError")),
    )

    response = client.post(
        "/detect/compare",
        files={"image": ("hero.png", sample_image_bytes, "image/png")},
        data={"confidence": "0.25"},
    )

    assert response.status_code == 200
    assert {m["source"] for m in response.json()["models"]} == {"circuitloop_yolo11s", "hf_yolov8s"}


def test_compare_does_not_merge_what_the_fallback_stage_merges(
    client, sample_image_bytes, monkeypatch
):
    """`/detect`'s fallback de-duplicates across models; `/detect/compare`
    deliberately does not. The comparison view must stay the raw one."""
    monkeypatch.setattr(client.app.state, "gemini_detection_service", None)

    detect = client.post(
        "/detect",
        files={"image": ("hero.png", sample_image_bytes, "image/png")},
        data={"confidence": "0.25"},
    ).json()
    compare = client.post(
        "/detect/compare",
        files={"image": ("hero.png", sample_image_bytes, "image/png")},
        data={"confidence": "0.25"},
    ).json()

    assert detect["source"] == "yolo_fallback"
    raw_total = sum(len(model["detections"]) for model in compare["models"])
    # The merge can only ever remove duplicates, never add detections.
    assert len(detect["detections"]) <= raw_total


def test_compare_rejects_the_same_invalid_inputs_as_detect(client):
    assert client.post("/detect/compare", files={"image": ("x.txt", b"nope", "text/plain")}).status_code == 415
    assert client.post("/detect/compare", files={"image": ("x.png", b"", "image/png")}).status_code == 400
    assert client.post("/detect/compare", files={"image": ("x.png", b"not png", "image/png")}).status_code == 400
