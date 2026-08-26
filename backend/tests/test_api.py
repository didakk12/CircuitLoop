import os
import tempfile

os.environ["CIRCUITLOOP_DATABASE_URL"] = f"sqlite:///{tempfile.gettempdir().replace(chr(92), '/')}/circuitloop-test.db"

from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)


def test_health():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "CircuitLoop Backend"}


def test_scan_and_detections_flow():
    scan_response = client.post("/api/scans", json={"image_path": "uploads/board.jpg"})
    assert scan_response.status_code == 201
    scan_id = scan_response.json()["id"]

    detections_response = client.post(
        "/api/detections",
        json={
            "scan_id": scan_id,
            "detections": [
                {
                    "type": "resistor",
                    "name": "R1",
                    "confidence": 0.94,
                    "bbox": {"x1": 120, "y1": 80, "x2": 180, "y2": 130},
                }
            ],
        },
    )
    assert detections_response.status_code == 201
    assert len(detections_response.json()) == 1
    assert client.get(f"/api/scans/{scan_id}").json()["total_components"] == 1


def test_component_test_and_dashboard():
    component_response = client.post(
        "/api/components",
        json={"type": "capacitor", "name": "C1", "confidence": 0.8},
    )
    assert component_response.status_code == 201
    component_id = component_response.json()["id"]

    result_response = client.post(
        f"/api/components/{component_id}/test",
        json={
            "expected_value": 10,
            "measured_value": 10.2,
            "unit": "uF",
            "status": "pass",
        },
    )
    assert result_response.status_code == 201
    assert client.get(f"/api/components/{component_id}").json()["status"] == "pass"

    stats = client.get("/api/dashboard/stats")
    assert stats.status_code == 200
    assert stats.json()["passed_components"] >= 1


def test_invalid_component_confidence():
    response = client.post(
        "/api/components",
        json={"type": "resistor", "confidence": 1.5},
    )
    assert response.status_code == 422
