"""Unit-level tests for SearchService, independent of the HTTP layer."""

import pytest

from search import SearchService, SearchServiceNotLoadedError


def test_search_raises_before_load_is_called():
    service = SearchService()

    with pytest.raises(SearchServiceNotLoadedError):
        service.search("irrelevant query")
