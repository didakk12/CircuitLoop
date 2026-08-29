"""POST /search — exercised against the real Neo4j vector index and the real
embedding model, end to end through the HTTP layer."""

from search import SearchService, SearchServiceNotLoadedError


def test_search_returns_real_relevant_results(client):
    response = client.post("/search", json={"query": "operating voltage", "top_k": 2})

    assert response.status_code == 200
    body = response.json()
    assert len(body["results"]) <= 2
    for result in body["results"]:
        assert set(result.keys()) == {"part_name", "section", "source_file", "text", "score"}
        assert isinstance(result["text"], str) and len(result["text"]) > 0


def test_search_results_carry_a_bounded_similarity_score(client):
    """The score is new with Neo4j: the FAISS path discarded its distance
    array, so nothing downstream could rank or threshold a hit."""
    response = client.post("/search", json={"query": "maximum operating temperature", "top_k": 3})

    assert response.status_code == 200
    results = response.json()["results"]
    assert results, "expected at least one hit from the real corpus"

    scores = [result["score"] for result in results]
    for score in scores:
        assert isinstance(score, float)
        assert 0.0 <= score <= 1.0
    # Best match first.
    assert scores == sorted(scores, reverse=True)


def test_search_finds_the_datasheet_that_actually_covers_the_query(client):
    """A query naming a part in the corpus should surface that part's own
    chunks — the substantive check that retrieval is semantically working,
    not just returning rows."""
    response = client.post("/search", json={"query": "ICM7555 general purpose timer", "top_k": 5})

    assert response.status_code == 200
    results = response.json()["results"]
    assert results

    assert any("ICM7555" in result["part_name"] for result in results), (
        f"expected an ICM7555 chunk, got parts: {[r['part_name'] for r in results]}"
    )
    # A genuine topical match should score well clear of noise.
    assert results[0]["score"] > 0.5


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


def test_search_returns_503_when_the_service_is_unavailable(client, monkeypatch):
    """An unloaded service (no Neo4j connection, no model) must surface as a
    clean 503 rather than an unhandled error."""
    monkeypatch.setattr(client.app.state, "search_service", SearchService())

    response = client.post("/search", json={"query": "voltage"})

    assert response.status_code == 503
    assert response.json()["error"] == "service_unavailable"


def test_unloaded_search_service_raises_rather_than_returning_empty():
    service = SearchService()

    try:
        service.search("irrelevant query")
    except SearchServiceNotLoadedError:
        pass
    else:  # pragma: no cover - the assertion below always fires if reached
        raise AssertionError("expected SearchServiceNotLoadedError")


def test_search_rejects_chunks_below_the_requested_threshold(client):
    """An unreachably high threshold must yield no results rather than the
    best-available ones — 'nothing relevant' is a real answer the assistant
    relies on to say it has no datasheet evidence."""
    response = client.post("/search", json={"query": "operating voltage", "top_k": 3, "min_score": 0.999})

    assert response.status_code == 200
    assert response.json()["results"] == []


def test_search_min_score_is_honoured_for_every_returned_chunk(client):
    threshold = 0.55
    response = client.post(
        "/search", json={"query": "maximum operating temperature", "top_k": 5, "min_score": threshold}
    )

    assert response.status_code == 200
    for result in response.json()["results"]:
        assert result["score"] >= threshold


def test_search_off_topic_query_is_filtered_by_the_default_threshold(client):
    """The case the threshold exists for: a question with nothing to do with
    electronics must not come back with three confident-looking datasheet
    excerpts. Measured off-topic top-1 scores sit near 0.57-0.63, below the
    0.65 default."""
    response = client.post("/search", json={"query": "best hiking trails in Norway", "top_k": 3})

    assert response.status_code == 200
    assert response.json()["results"] == []


def test_search_genuine_query_survives_the_default_threshold(client):
    """The complement of the test above — the threshold must not be so strict
    that real component questions lose their evidence."""
    response = client.post("/search", json={"query": "ICM7555 general purpose timer", "top_k": 3})

    assert response.status_code == 200
    results = response.json()["results"]
    assert results, "a genuine component query returned nothing; threshold is too strict"
    assert any("ICM7555" in result["part_name"] for result in results)


def test_search_min_score_out_of_range_returns_422(client):
    assert client.post("/search", json={"query": "voltage", "min_score": 1.5}).status_code == 422
    assert client.post("/search", json={"query": "voltage", "min_score": -0.1}).status_code == 422
