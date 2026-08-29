"""Unit-level tests for SearchService, independent of the HTTP layer."""

import pytest

from neo4j_store import EMBEDDING_DIMENSIONS
from search import EMBEDDING_MODEL_NAME, SearchService, SearchServiceNotLoadedError


def test_search_raises_before_load_is_called():
    service = SearchService()

    with pytest.raises(SearchServiceNotLoadedError):
        service.search("irrelevant query")


def test_load_without_a_store_is_rejected():
    """Neo4j is the corpus, so a SearchService with no store has nothing to
    search — that must fail loudly at load(), not silently return no hits."""
    service = SearchService()

    with pytest.raises(SearchServiceNotLoadedError):
        service.load()


def test_is_loaded_is_false_before_load():
    assert SearchService().is_loaded is False


def test_index_online_is_false_without_a_store():
    """/health must report "not ready" rather than raise when the store is absent."""
    assert SearchService().is_index_online() is False


def test_loaded_service_reports_ready_and_returns_scored_results(rag_store):
    service = SearchService(store=rag_store)
    service.load()

    assert service.is_loaded is True
    assert service.is_index_online() is True

    results = service.search("absolute maximum ratings", top_k=3)
    assert results
    for result in results:
        assert 0.0 <= result.score <= 1.0
    # `rag_store` is session-scoped and shared, so the connection is left open
    # for other tests; service.close() would tear it down underneath them.


def test_embedding_model_width_matches_the_vector_index(rag_store):
    """The startup assertion in SearchService.load() has real content: the
    configured model genuinely produces the width the index was built for."""
    from sentence_transformers import SentenceTransformer

    from search import _embedding_dimension_of

    model = SentenceTransformer(EMBEDDING_MODEL_NAME)
    assert _embedding_dimension_of(model) == EMBEDDING_DIMENSIONS
    assert rag_store.vector_index_info()["dimensions"] == EMBEDDING_DIMENSIONS
