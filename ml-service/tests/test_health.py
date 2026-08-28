def test_health_returns_ok_with_both_services_loaded(client):
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body == {"status": "ok", "model_loaded": True, "index_loaded": True}
