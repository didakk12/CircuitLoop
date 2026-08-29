"""
Neo4j RAG store: node storage, vector index, similarity retrieval, scores,
and ingestion idempotency.

These run against the real, live Neo4j — the whole point of the migration is
that retrieval is a database operation now, and a mocked driver would prove
nothing about whether the vector index actually works.

Isolation: every test that writes uses `synthetic_chunks`, whose ids are
content-addressed over deliberately unique text, so they cannot collide with
the real corpus and are deleted again in the fixture teardown. Read-only
assertions about the real corpus are expressed as invariants (">= 1 node",
"all embeddings same width") rather than exact counts, so re-ingesting or
extending the corpus does not break the suite.
"""

from __future__ import annotations

import pytest

from neo4j_store import (
    EMBEDDING_DIMENSIONS,
    NODE_LABEL,
    SIMILARITY_FUNCTION,
    VECTOR_INDEX_NAME,
    ChunkRecord,
    RagStore,
    RagStoreNotConnectedError,
    content_id,
)

SYNTHETIC_SOURCE = "__pytest_synthetic__.pdf"


def _vector(seed: float) -> list[float]:
    """A deterministic unit-ish vector of the right width. Values are tiny and
    concentrated in one coordinate so synthetic chunks never outrank real
    corpus chunks for a natural-language query."""
    vector = [0.0] * EMBEDDING_DIMENSIONS
    vector[0] = 1.0
    vector[1] = seed
    return vector


def _record(index: int) -> ChunkRecord:
    text = f"Synthetic pytest chunk number {index} for the CircuitLoop RAG store suite."
    part_name = f"PYTEST{index}"
    section = "features"
    return ChunkRecord(
        id=content_id(SYNTHETIC_SOURCE, part_name, section, text),
        chunk_id=f"{part_name}_{section}_0",
        part_name=part_name,
        section=section,
        source_file=SYNTHETIC_SOURCE,
        text=text,
        embedding=_vector(index / 100.0),
    )


@pytest.fixture
def synthetic_chunks(rag_store: RagStore):
    """Three synthetic chunks, removed again afterwards regardless of outcome."""
    records = [_record(i) for i in range(3)]
    yield records
    rag_store.delete_chunks_by_ids([record.id for record in records])


# --- A. Chunk storage -------------------------------------------------------


def test_stored_chunk_has_text_metadata_and_embedding(rag_store: RagStore, synthetic_chunks):
    rag_store.upsert_chunks(synthetic_chunks)

    stored = rag_store._run(
        f"""
        MATCH (d:{NODE_LABEL} {{ id: $id }})
        RETURN d.text AS text, d.partName AS part_name, d.section AS section,
               d.sourceFile AS source_file, d.chunkId AS chunk_id,
               size(d.embedding) AS dims
        """,
        id=synthetic_chunks[0].id,
    )

    assert len(stored) == 1
    node = stored[0]
    assert node["text"] == synthetic_chunks[0].text
    assert node["part_name"] == synthetic_chunks[0].part_name
    assert node["section"] == synthetic_chunks[0].section
    assert node["source_file"] == SYNTHETIC_SOURCE
    assert node["chunk_id"] == synthetic_chunks[0].chunk_id
    assert node["dims"] == EMBEDDING_DIMENSIONS


def test_real_corpus_is_present_and_fully_embedded(rag_store: RagStore):
    stats = rag_store.corpus_stats()

    assert stats["total"] > 0, "RAG corpus is empty — run: python pipeline/ingest.py"
    # Every node carries a vector: no half-ingested corpus.
    assert stats["with_embedding"] == stats["total"]
    # Every id is distinct: the uniqueness constraint is doing its job.
    assert stats["distinct_ids"] == stats["total"]
    # One consistent width, matching the index.
    assert stats["min_dims"] == stats["max_dims"] == EMBEDDING_DIMENSIONS


def test_uniqueness_constraint_rejects_a_duplicate_id(rag_store: RagStore, synthetic_chunks):
    rag_store.upsert_chunks(synthetic_chunks)
    duplicate_id = synthetic_chunks[0].id

    with pytest.raises(Exception) as excinfo:
        rag_store._run(
            f"CREATE (d:{NODE_LABEL} {{ id: $id, text: 'x' }}) RETURN d",
            id=duplicate_id,
        )
    assert "already exists" in str(excinfo.value).lower() or "constraint" in str(excinfo.value).lower()


# --- B. Vector index --------------------------------------------------------


def test_vector_index_exists_and_is_online(rag_store: RagStore):
    info = rag_store.vector_index_info()

    assert info is not None, f"{VECTOR_INDEX_NAME} does not exist"
    assert info["type"] == "VECTOR"
    assert info["state"] == "ONLINE"
    assert info["labels"] == [NODE_LABEL]
    assert info["properties"] == ["embedding"]
    assert rag_store.is_index_online() is True


def test_vector_index_dimensions_and_similarity_match_the_embedding_model(rag_store: RagStore):
    info = rag_store.vector_index_info()

    assert info["dimensions"] == EMBEDDING_DIMENSIONS
    assert str(info["similarity_function"]).lower() == SIMILARITY_FUNCTION.lower()


# --- C/D. Vector retrieval and scores ---------------------------------------


def test_query_returns_the_nearest_chunk_first(rag_store: RagStore, synthetic_chunks):
    rag_store.upsert_chunks(synthetic_chunks)

    # Query with one synthetic chunk's own vector: it must be its own best match.
    target = synthetic_chunks[1]
    hits = rag_store.query_similar_chunks(target.embedding, top_k=5)

    assert hits, "vector query returned nothing"
    assert hits[0].part_name == target.part_name
    assert hits[0].text == target.text
    # Cosine similarity of a vector with itself is 1.0 (allowing float error).
    assert hits[0].score == pytest.approx(1.0, abs=1e-4)


def test_query_returns_metadata_and_a_bounded_score(rag_store: RagStore, synthetic_chunks):
    rag_store.upsert_chunks(synthetic_chunks)
    hits = rag_store.query_similar_chunks(synthetic_chunks[0].embedding, top_k=3)

    assert hits
    for hit in hits:
        assert isinstance(hit.part_name, str) and hit.part_name
        assert isinstance(hit.section, str)
        assert isinstance(hit.source_file, str) and hit.source_file
        assert isinstance(hit.text, str) and hit.text
        # Score is present, real, and bounded — the FAISS path had no score at all.
        assert isinstance(hit.score, float)
        assert 0.0 <= hit.score <= 1.0

    # Results are ordered best-first.
    assert [hit.score for hit in hits] == sorted((hit.score for hit in hits), reverse=True)


def test_top_k_limits_the_result_count(rag_store: RagStore):
    assert len(rag_store.query_similar_chunks(_vector(0.5), top_k=1)) <= 1
    assert len(rag_store.query_similar_chunks(_vector(0.5), top_k=4)) <= 4


# --- E. Idempotent ingestion ------------------------------------------------


def test_ingesting_twice_does_not_duplicate_chunks(rag_store: RagStore, synthetic_chunks):
    first = rag_store.upsert_chunks(synthetic_chunks)
    assert first["created"] == len(synthetic_chunks)

    second = rag_store.upsert_chunks(synthetic_chunks)

    # The corpus did not grow: MERGE on the content-addressed id rewrote the
    # same three nodes. This is the property that lets ingestion be re-run.
    assert second["created"] == 0
    assert second["nodes_after"] == first["nodes_after"]

    stats = rag_store.corpus_stats()
    assert stats["distinct_ids"] == stats["total"]


def test_content_id_is_stable_and_content_sensitive():
    args = ("f.pdf", "PART", "features", "some text")

    # Deterministic: the same content always yields the same id, which is what
    # makes re-ingestion idempotent rather than duplicating.
    assert content_id(*args) == content_id(*args)

    # Sensitive to every field, so genuinely different chunks never collide.
    assert content_id(*args) != content_id("g.pdf", "PART", "features", "some text")
    assert content_id(*args) != content_id("f.pdf", "OTHER", "features", "some text")
    assert content_id(*args) != content_id("f.pdf", "PART", "general", "some text")
    assert content_id(*args) != content_id("f.pdf", "PART", "features", "other text")


def test_content_id_is_not_confused_by_field_boundaries():
    """Concatenating fields without a separator would make ("ab","c") and
    ("a","bc") hash identically. The NUL separator prevents that."""
    assert content_id("f.pdf", "AB", "C", "t") != content_id("f.pdf", "A", "BC", "t")


# --- G. Neo4j is the source of truth ----------------------------------------


def test_store_refuses_to_operate_before_connect():
    disconnected = RagStore("neo4j://127.0.0.1:7687", "u", "p")

    with pytest.raises(RagStoreNotConnectedError):
        disconnected.count_chunks()
    with pytest.raises(RagStoreNotConnectedError):
        disconnected.query_similar_chunks([0.0] * EMBEDDING_DIMENSIONS)


def test_deleting_a_chunk_removes_it_from_retrieval(rag_store: RagStore, synthetic_chunks):
    """Retrieval reads through to Neo4j on every call — there is no in-process
    index or cached copy that could keep serving a deleted chunk."""
    rag_store.upsert_chunks(synthetic_chunks)
    target = synthetic_chunks[2]

    before = rag_store.query_similar_chunks(target.embedding, top_k=5)
    assert any(hit.text == target.text for hit in before)

    rag_store.delete_chunks_by_ids([target.id])

    after = rag_store.query_similar_chunks(target.embedding, top_k=5)
    assert not any(hit.text == target.text for hit in after)


# --- Relevance threshold (Phase 2) ------------------------------------------


def test_min_score_filters_out_weak_matches(rag_store: RagStore, synthetic_chunks):
    """A threshold above a chunk's actual similarity must exclude it, rather
    than the query padding results out to top_k regardless of quality."""
    rag_store.upsert_chunks(synthetic_chunks)
    target = synthetic_chunks[0]

    # Its own vector scores ~1.0, so a 0.99 floor still keeps it...
    kept = rag_store.query_similar_chunks(target.embedding, top_k=5, min_score=0.99)
    assert any(hit.text == target.text for hit in kept)

    # ...while a floor above 1.0 is unreachable for cosine and must keep nothing.
    assert rag_store.query_similar_chunks(target.embedding, top_k=5, min_score=1.01) == []


def test_min_score_zero_keeps_everything_top_k_returned(rag_store: RagStore):
    unfiltered = rag_store.query_similar_chunks(_vector(0.3), top_k=5, min_score=0.0)
    assert len(unfiltered) == 5
    assert all(0.0 <= hit.score <= 1.0 for hit in unfiltered)


def test_every_returned_chunk_meets_the_threshold(rag_store: RagStore):
    threshold = 0.5
    hits = rag_store.query_similar_chunks(_vector(0.7), top_k=10, min_score=threshold)
    assert all(hit.score >= threshold for hit in hits)


def test_raising_the_threshold_never_increases_the_result_count(rag_store: RagStore):
    """Monotonicity: the filter only ever removes. Guards against an inverted
    comparison in the Cypher WHERE clause, which a single fixed-threshold test
    would not catch."""
    probe = _vector(0.42)
    counts = [
        len(rag_store.query_similar_chunks(probe, top_k=10, min_score=threshold))
        for threshold in (0.0, 0.25, 0.5, 0.75, 0.95)
    ]
    assert counts == sorted(counts, reverse=True), counts


def test_default_min_score_sits_between_offtopic_and_genuine_queries():
    """The default was calibrated against the real corpus: off-topic queries
    top out near 0.63 and genuine electronics queries start near 0.67. This
    pins the constant so a casual edit can't silently disable filtering (0.0)
    or reject everything (1.0)."""
    from neo4j_store import DEFAULT_MIN_SCORE

    assert 0.63 < DEFAULT_MIN_SCORE < 0.67
