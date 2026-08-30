def test_health_returns_ok_with_both_services_loaded(client):
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["model_loaded"] is True
    assert body["index_loaded"] is True
    assert set(body) == {
        "status",
        "model_loaded",
        "index_loaded",
        "gemini_configured",
    }
