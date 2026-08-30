"""
Query-time RAG retrieval: embed the question, then run a vector similarity
search against **Neo4j**.

Storage and retrieval both live in Neo4j (see neo4j_store.py). This module
owns only the part that genuinely needs the Python ML ecosystem -- turning a
query string into an embedding with sentence-transformers -- and delegates
the actual similarity search to Neo4j's vector index.

History: this file previously loaded a FAISS `IndexFlatL2` from
`vector_db/circuitloop.index` and resolved hits against a parallel
`data/metadata.json` list, using the FAISS row number as an index into that
list. Both are gone. That design had the corpus split across two files that
had to stay positionally aligned, and it kept the RAG corpus outside the
database the rest of the application already used. Neo4j now holds the text,
the metadata and the vector on a single node, so a hit carries its own
metadata and nothing can fall out of alignment.

Retrieval only -- still no generation/LLM call here. That remains the
TypeScript backend's job, per ML_SERVICE_INTEGRATION_PLAN.md section 6, and
this change does not move it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sentence_transformers import SentenceTransformer

from neo4j_store import (
    DEFAULT_MIN_SCORE,
    DEFAULT_TOP_K,
    EMBEDDING_DIMENSIONS,
    RagStore,
    SchemaMismatchError,
)

logger = logging.getLogger(__name__)

EMBEDDING_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"


def _embedding_dimension_of(model: SentenceTransformer) -> int:
    """Output width of the loaded model.

    sentence-transformers 5.x renamed `get_sentence_embedding_dimension()` to
    `get_embedding_dimension()` and warns on the old name; both spellings are
    accepted here so this works either side of that rename.
    """
    getter = getattr(model, "get_embedding_dimension", None) or model.get_sentence_embedding_dimension
    return int(getter())


@dataclass
class SearchResult:
    part_name: str
    section: str
    source_file: str
    text: str
    # Cosine similarity in [0, 1] as computed by Neo4j's vector index. New in
    # the Neo4j migration: the previous FAISS path discarded the distance
    # array entirely, so callers had no way to tell a strong hit from a weak
    # one.
    score: float


class SearchServiceNotLoadedError(RuntimeError):
    """Raised when search is attempted before the model/store have loaded."""


class SearchService:
    """Loads the embedding model once and serves searches against the Neo4j
    vector index -- a long-lived service keeps this model warm in memory
    instead of reloading it per request.

    The `RagStore` is injected so tests can supply their own (pointing at the
    same live database) without this class owning connection policy.
    """

    def __init__(self, store: RagStore | None = None) -> None:
        self._store = store
        self._model: SentenceTransformer | None = None

    def load(self) -> None:
        if self._store is None:
            raise SearchServiceNotLoadedError(
                "SearchService requires a RagStore -- Neo4j is the RAG corpus store"
            )

        if not self._store.is_connected:
            self._store.connect()
        self._store.ensure_schema()

        self._model = SentenceTransformer(EMBEDDING_MODEL_NAME)

        # The index was created for EMBEDDING_DIMENSIONS; if the model ever
        # produces a different width, every subsequent query would be
        # rejected by Neo4j with a confusing per-request error. Fail here
        # instead, at startup, naming the real cause.
        actual_dimensions = _embedding_dimension_of(self._model)
        if actual_dimensions != EMBEDDING_DIMENSIONS:
            raise SchemaMismatchError(
                f"Embedding model {EMBEDDING_MODEL_NAME!r} produces {actual_dimensions} "
                f"dimensions but the vector index expects {EMBEDDING_DIMENSIONS}. "
                f"Rebuild the corpus with a matching model."
            )

        stats = self._store.corpus_stats()
        logger.info(
            "Search service loaded: %d DatasheetChunk nodes (%d with embeddings) "
            "across %d source files, Neo4j vector index online",
            stats.get("total", 0),
            stats.get("with_embedding", 0),
            stats.get("source_files", 0),
        )

    @property
    def is_loaded(self) -> bool:
        return (
            self._model is not None
            and self._store is not None
            and self._store.is_connected
        )

    def is_index_online(self) -> bool:
        """Live readiness of the Neo4j vector index, for /health.

        Checked per call rather than cached from startup: the index is a
        separate resource that can be dropped or go POPULATING after this
        process came up, and a health probe that cannot notice that is not
        telling the caller anything useful.
        """
        if self._store is None or not self._store.is_connected:
            return False
        try:
            return self._store.is_index_online()
        except Exception:  # noqa: BLE001 -- health must report, never raise
            logger.warning("Vector index status check failed", exc_info=True)
            return False

    def close(self) -> None:
        if self._store is not None:
            self._store.close()

    def search(
        self,
        query: str,
        top_k: int = DEFAULT_TOP_K,
        min_score: float = DEFAULT_MIN_SCORE,
    ) -> list[SearchResult]:
        """Embed `query` and return the chunks above `min_score`, best first.

        May return fewer than `top_k` results, including none at all: a query
        with no sufficiently similar chunk yields an empty list rather than
        weak matches padded to a fixed count. Callers must treat "no results"
        as a real, expected answer meaning "no relevant datasheet evidence".
        """
        if self._model is None or self._store is None or not self._store.is_connected:
            raise SearchServiceNotLoadedError("Call load() before search()")

        query_embedding = self._model.encode(
            query,
            convert_to_numpy=True,
            # Matches how the corpus vectors were produced. Required for the
            # cosine scores to be meaningful and for parity with the previous
            # normalized-vector FAISS behaviour.
            normalize_embeddings=True,
        ).astype("float32")

        hits = self._store.query_similar_chunks(
            query_embedding.tolist(), top_k=top_k, min_score=min_score
        )
        return [
            SearchResult(
                part_name=hit.part_name,
                section=hit.section,
                source_file=hit.source_file,
                text=hit.text,
                score=hit.score,
            )
            for hit in hits
        ]
