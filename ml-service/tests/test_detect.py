"""
POST /detect — exercised against the real trained model and a real image
(session-scoped `client`/`sample_image_bytes` fixtures), plus invalid-input
and error-path cases per §9 Phase 6's explicit requirements: invalid requests,
malformed images, detection response validation, service errors.
"""

import dataclasses

import app as app_module
from detection import DetectionService

KNOWN_CLASSES = {"battery", "buzzer", "capacitor", "display", "ic", "relay", "resistor", "switch"}


def test_detect_with_real_image_returns_real_validated_detections(client, sample_image_bytes):
    response = client.post(
        "/detect",
        files={"image": ("hero.png", sample_image_bytes, "image/png")},
        data={"confidence": "0.01"},
    )

    assert response.status_code == 200
    body = response.json()
    assert "detections" in body
    assert len(body["detections"]) > 0

    for detection in body["detections"]:
        # Response validation: exact shape, per DetectionModel in schemas.py.
        assert set(detection.keys()) == {"class_name", "confidence", "bbox", "text"}
        assert set(detection["bbox"].keys()) == {"x1", "y1", "x2", "y2"}
        # The class name must be one of the model's real, verified classes —
        # never a guessed/invented label (see ML_SERVICE_INTEGRATION_PLAN.md).
        assert detection["class_name"] in KNOWN_CLASSES
        assert 0.0 <= detection["confidence"] <= 1.0
        assert isinstance(detection["text"], str)


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


def test_detect_returns_503_when_the_model_is_unavailable(client, sample_image_bytes, monkeypatch):
    """Service-error path: simulates the model not being loaded, without
    actually tearing down the shared session-scoped app (monkeypatch
    reverts automatically after this test)."""
    unloaded_service = DetectionService()
    monkeypatch.setattr(client.app.state, "detection_service", unloaded_service)

    response = client.post("/detect", files={"image": ("hero.png", sample_image_bytes, "image/png")})

    assert response.status_code == 503
    assert response.json()["error"] == "service_unavailable"


# --- POST /detect/compare ----------------------------------------------------
#
# Benchmarking endpoint: runs every loaded detector over one image and returns
# each model's raw detections separately. Nothing is merged or suppressed.

HF_CLASSES = {
    "battery", "button", "buzzer", "capacitor", "clock", "connector", "diode",
    "display", "fuse", "heatsink", "ic", "inductor", "led", "pads", "pins",
    "potentiometer", "relay", "resistor", "switch", "transformer", "transistor",
}


def test_compare_returns_both_models_separately(client, sample_image_bytes):
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


def test_compare_does_not_change_what_detect_returns(client, sample_image_bytes):
    """The whole point of a separate endpoint: adding a second model must leave
    the existing /detect contract and its results byte-for-byte identical."""
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

    primary = next(m for m in compare["models"] if m["source"] == "circuitloop_yolo11s")

    assert detect["detections"] == primary["detections"]
    assert set(detect.keys()) == {"detections"}  # no `source` leaked into /detect


def test_compare_rejects_the_same_invalid_inputs_as_detect(client):
    assert client.post("/detect/compare", files={"image": ("x.txt", b"nope", "text/plain")}).status_code == 415
    assert client.post("/detect/compare", files={"image": ("x.png", b"", "image/png")}).status_code == 400
    assert client.post("/detect/compare", files={"image": ("x.png", b"not png", "image/png")}).status_code == 400
