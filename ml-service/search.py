"""
FAISS/embeddings retrieval — consolidated from what were previously two
duplicate implementations of the same logic, both branch-only:
`rag/app.py` (standalone search FastAPI app) and
`backend/services/ai_service.py` (the same retrieval re-implemented inside
the now-retired Python CRUD backend). See ML_SERVICE_INTEGRATION_PLAN.md
§0/§9 Phase 1 — both originals are retired; this is the single remaining
implementation.

Retrieval only. No generation/LLM call — see
ML_SERVICE_INTEGRATION_PLAN.md §6 for why generation is planned to live in
the TypeScript backend instead, and why that's a deliberate architectural
choice, not this phase's job to build.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_INDEX_PATH = PROJECT_ROOT / "vector_db" / "circuitloop.index"
DEFAULT_METADATA_PATH = PROJECT_ROOT / "data" / "metadata.json"
EMBEDDING_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_TOP_K = 3


@dataclass
class SearchResult:
    part_name: str
    section: str
    source_file: str
    text: str


class SearchServiceNotLoadedError(RuntimeError):
    """Raised when search is attempted before the index/model have successfully loaded."""


class SearchService:
    """Loads the embedding model + FAISS index once and serves search
    requests against them — same "load once, reuse the process's lifetime"
    pattern as `DetectionService` in `detection.py`, for the same reason."""

    def __init__(
        self,
        index_path: Path = DEFAULT_INDEX_PATH,
        metadata_path: Path = DEFAULT_METADATA_PATH,
    ) -> None:
        self._index_path = index_path
        self._metadata_path = metadata_path
        self._model: SentenceTransformer | None = None
        self._index: faiss.Index | None = None
        self._metadata: list[dict] | None = None

    def load(self) -> None:
        if not self._index_path.exists():
            raise FileNotFoundError(f"FAISS index not found at {self._index_path}")
        if not self._metadata_path.exists():
            raise FileNotFoundError(f"Metadata file not found at {self._metadata_path}")

        self._model = SentenceTransformer(EMBEDDING_MODEL_NAME)
        self._index = faiss.read_index(str(self._index_path))
        with self._metadata_path.open("r", encoding="utf-8") as f:
            self._metadata = json.load(f)

        logger.info(
            "Search service loaded: %d vectors in FAISS index, %d metadata records",
            self._index.ntotal,
            len(self._metadata),
        )

    @property
    def is_loaded(self) -> bool:
        return self._model is not None and self._index is not None and self._metadata is not None

    def search(self, query: str, top_k: int = DEFAULT_TOP_K) -> list[SearchResult]:
        if self._model is None or self._index is None or self._metadata is None:
            raise SearchServiceNotLoadedError("Call load() before search()")

        query_embedding = self._model.encode(
            query,
            convert_to_numpy=True,
            normalize_embeddings=True,
        ).astype("float32")

        _, indices = self._index.search(np.array([query_embedding]), k=min(top_k, self._index.ntotal))

        results: list[SearchResult] = []
        for idx in indices[0]:
            if idx < 0:
                continue
            chunk = self._metadata[idx]
            results.append(
                SearchResult(
                    part_name=chunk["part_name"],
                    section=chunk["section"],
                    source_file=chunk["source_file"],
                    text=chunk["text"],
                )
            )
        return results
