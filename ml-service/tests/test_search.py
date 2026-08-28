"""POST /search — exercised against the real FAISS index and real embedding model."""

from search import SearchService


def test_search_returns_real_relevant_results(client):
    response = client.post("/search", json={"query": "operating voltage", "top_k": 2})

    assert response.status_code == 200
    body = response.json()
    assert len(body["results"]) <= 2
    for result in body["results"]:
        assert set(result.keys()) == {"part_name", "section", "source_file", "text"}
        assert isinstance(result["text"], str) and len(result["text"]) > 0


def test_search_default_top_k_is_three(client):
    response = client.post("/search", json={"query": "voltage regulator"})

    assert response.status_code == 200
    assert len(response.json()["results"]) <= 3


def test_search_empty_query_returns_422(client):
    response = client.post("/search", json={"query": ""})

    assert response.status_code == 422
    assert response.json()["error"] == "validation_error"


def test_search_missing_query_returns_422(client):
    response = client.post("/search", json={})

    assert response.status_code == 422


def test_search_top_k_out_of_range_returns_422(client):
    response = client.post("/search", json={"query": "voltage", "top_k": 0})

    assert response.status_code == 422


def test_search_returns_503_when_the_index_is_unavailable(client, monkeypatch):
    unloaded_service = SearchService()
    monkeypatch.setattr(client.app.state, "search_service", unloaded_service)

    response = client.post("/search", json={"query": "voltage"})

    assert response.status_code == 503
    assert response.json()["error"] == "service_unavailable"
