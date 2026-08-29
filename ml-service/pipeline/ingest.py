"""
RAG ingestion: chunks -> embeddings -> Neo4j.

    PDFs --(extract_and_chunk.py)--> data/chunks.json --(this script)--> Neo4j
                                                                          |
                                                          (:DatasheetChunk) nodes
                                                          + vector index -> retrieval

Replaces the two scripts this stage used to need (`create_embeddings.py`,
which wrote embeddings.npy + metadata.json, and `build_faiss_index.py`, which
turned those into a FAISS IndexFlatL2). Both are gone: there is no longer an
intermediate embedding file or a FAISS index, because Neo4j stores the text,
the metadata and the vector together on one node.

Idempotency
-----------
Every chunk gets a content-addressed id (`neo4j_store.content_id`), and the
write is a MERGE on that id. Running ingestion twice over the same input
rewrites the same nodes rather than adding new ones, so the corpus cannot
double -- which is exactly what `--verify` and the test suite assert.

Usage
-----
    # Normal path: embed data/chunks.json and load it into Neo4j.
    python pipeline/ingest.py

    # Load a precomputed embedding set (a chunk-metadata JSON plus a .npy of
    # the same length and order). This was used once to migrate the
    # pre-existing FAISS-era corpus without re-embedding it, so the stored
    # vectors are bit-identical to the ones it was built with; those two
    # source files have since been deleted. It stays as a general capability
    # for loading vectors embedded elsewhere (e.g. on a GPU machine).
    python pipeline/ingest.py --embedded <chunks-metadata.json> <embeddings.npy>

    # Report what is currently in Neo4j and exit without writing.
    python pipeline/ingest.py --verify

    # Delete every DatasheetChunk before loading (full rebuild).
    python pipeline/ingest.py --reset
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

import numpy as np

PIPELINE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = PIPELINE_DIR.parent
# The service modules live in ml-service/, this script in ml-service/pipeline/.
sys.path.insert(0, str(PROJECT_ROOT))

from config import MISSING_NEO4J_MESSAGE, load_neo4j_settings  # noqa: E402
from neo4j_store import (  # noqa: E402
    EMBEDDING_DIMENSIONS,
    ChunkRecord,
    RagStore,
    content_id,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ingest")

DEFAULT_CHUNKS_FILE = PROJECT_ROOT / "data" / "chunks.json"
REQUIRED_CHUNK_FIELDS = ("chunk_id", "part_name", "section", "source_file", "text")


def _load_chunk_dicts(path: Path) -> list[dict]:
    if not path.exists():
        raise SystemExit(f"Chunk file not found: {path}")
    with path.open("r", encoding="utf-8") as handle:
        chunks = json.load(handle)
    if not chunks:
        raise SystemExit(f"No chunks found in {path}")
    for position, chunk in enumerate(chunks):
        missing = [field for field in REQUIRED_CHUNK_FIELDS if not isinstance(chunk.get(field), str)]
        if missing:
            raise SystemExit(f"Chunk at position {position} is missing string field(s): {missing}")
        if not chunk["text"].strip():
            raise SystemExit(f"Chunk at position {position} ({chunk['chunk_id']}) has empty text")
    return chunks


def _to_records(chunks: list[dict], embeddings: np.ndarray) -> list[ChunkRecord]:
    """Pairs chunks with their embeddings and assigns content-addressed ids.

    De-duplicates by id in-process as well as at the MERGE, so the reported
    counts describe what actually lands in the database. In the migrated
    corpus this collapses 4 byte-identical records (728 -> 724); those pairs
    have identical text *and* identical vectors, so nothing distinguishable
    is lost -- see the RAG section of ml-service/README.md.
    """
    if embeddings.shape[0] != len(chunks):
        raise SystemExit(
            f"Embedding/chunk count mismatch: {embeddings.shape[0]} embeddings vs {len(chunks)} chunks"
        )
    if embeddings.ndim != 2 or embeddings.shape[1] != EMBEDDING_DIMENSIONS:
        raise SystemExit(
            f"Expected embeddings of shape (n, {EMBEDDING_DIMENSIONS}), got {embeddings.shape}"
        )

    by_id: dict[str, ChunkRecord] = {}
    duplicates = 0
    for chunk, vector in zip(chunks, embeddings):
        identifier = content_id(
            chunk["source_file"], chunk["part_name"], chunk["section"], chunk["text"]
        )
        if identifier in by_id:
            duplicates += 1
            continue
        by_id[identifier] = ChunkRecord(
            id=identifier,
            chunk_id=chunk["chunk_id"],
            part_name=chunk["part_name"],
            section=chunk["section"],
            source_file=chunk["source_file"],
            text=chunk["text"],
            embedding=[float(value) for value in vector],
        )

    if duplicates:
        logger.info(
            "Collapsed %d byte-identical duplicate chunk(s): %d input records -> %d distinct chunks",
            duplicates,
            len(chunks),
            len(by_id),
        )
    return list(by_id.values())


def _embed(chunks: list[dict]) -> np.ndarray:
    """Embeds chunk text with the same model and normalization the retrieval
    path uses, so query and corpus vectors live in the same space."""
    from search import EMBEDDING_MODEL_NAME  # imported lazily: heavy, and unused by --embedded
    from sentence_transformers import SentenceTransformer

    logger.info("Loading embedding model %s ...", EMBEDDING_MODEL_NAME)
    model = SentenceTransformer(EMBEDDING_MODEL_NAME)
    logger.info("Generating embeddings for %d chunks ...", len(chunks))
    return model.encode(
        [chunk["text"] for chunk in chunks],
        show_progress_bar=True,
        convert_to_numpy=True,
        normalize_embeddings=True,
    )


def _print_verification(store: RagStore) -> None:
    stats = store.corpus_stats()
    index = store.vector_index_info()

    print("\n--- Neo4j RAG corpus ---")
    print(f"  DatasheetChunk nodes : {stats.get('total', 0)}")
    print(f"  with embedding       : {stats.get('with_embedding', 0)}")
    print(f"  distinct ids         : {stats.get('distinct_ids', 0)}")
    print(f"  distinct source files: {stats.get('source_files', 0)}")
    print(f"  distinct part names  : {stats.get('part_names', 0)}")
    print(f"  embedding dimensions : min={stats.get('min_dims')} max={stats.get('max_dims')}")

    print("\n--- Vector index ---")
    if index is None:
        print("  MISSING")
    else:
        print(f"  name       : {index['name']}")
        print(f"  type/state : {index['type']} / {index['state']}")
        print(f"  target     : {index['labels']}.{index['properties']}")
        print(f"  dimensions : {index['dimensions']}")
        print(f"  similarity : {index['similarity_function']}")

    sample = store.sample_chunk()
    if sample:
        print("\n--- Sample chunk ---")
        print(f"  id        : {sample['id'][:16]}...")
        print(f"  chunkId   : {sample['chunk_id']}")
        print(f"  partName  : {sample['part_name']}")
        print(f"  section   : {sample['section']}")
        print(f"  sourceFile: {sample['source_file']}")
        print(f"  dims      : {sample['dims']}")
        print(f"  text      : {sample['text'][:120].replace(chr(10), ' ')}...")

    duplicates = stats.get("total", 0) - stats.get("distinct_ids", 0)
    missing_vectors = stats.get("total", 0) - stats.get("with_embedding", 0)
    print("\n--- Checks ---")
    print(f"  no duplicate ids           : {'PASS' if duplicates == 0 else f'FAIL ({duplicates})'}")
    print(f"  every chunk has an embedding: {'PASS' if missing_vectors == 0 else f'FAIL ({missing_vectors})'}")
    print(
        f"  all embeddings {EMBEDDING_DIMENSIONS}-d          : "
        f"{'PASS' if stats.get('min_dims') == stats.get('max_dims') == EMBEDDING_DIMENSIONS else 'FAIL'}"
    )
    print(
        f"  vector index ONLINE         : "
        f"{'PASS' if index is not None and index['state'] == 'ONLINE' else 'FAIL'}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Load the RAG corpus into Neo4j")
    parser.add_argument(
        "--chunks",
        type=Path,
        default=DEFAULT_CHUNKS_FILE,
        help=f"Chunk JSON produced by extract_and_chunk.py (default: {DEFAULT_CHUNKS_FILE})",
    )
    parser.add_argument(
        "--embedded",
        nargs=2,
        metavar=("METADATA_JSON", "EMBEDDINGS_NPY"),
        type=Path,
        help="Load precomputed embeddings instead of generating them",
    )
    parser.add_argument("--reset", action="store_true", help="Delete all DatasheetChunk nodes first")
    parser.add_argument("--verify", action="store_true", help="Report corpus/index state and exit")
    parser.add_argument("--batch-size", type=int, default=250)
    args = parser.parse_args()

    neo4j_settings = load_neo4j_settings()
    if neo4j_settings is None:
        raise SystemExit(MISSING_NEO4J_MESSAGE)

    store = RagStore(
        uri=neo4j_settings.uri,
        username=neo4j_settings.username,
        password=neo4j_settings.password,
        database=neo4j_settings.database,
    )
    store.connect()
    try:
        store.ensure_schema()

        if args.verify:
            _print_verification(store)
            return

        if args.embedded:
            metadata_path, embeddings_path = args.embedded
            logger.info("Loading precomputed embeddings from %s / %s", metadata_path, embeddings_path)
            chunks = _load_chunk_dicts(metadata_path)
            embeddings = np.load(embeddings_path)
        else:
            chunks = _load_chunk_dicts(args.chunks)
            embeddings = _embed(chunks)

        records = _to_records(chunks, np.asarray(embeddings, dtype="float32"))

        if args.reset:
            deleted = store.delete_all_chunks()
            logger.info("Reset: deleted %d existing DatasheetChunk nodes", deleted)

        result = store.upsert_chunks(records, batch_size=args.batch_size)
        logger.info(
            "Ingestion complete: %d chunks written, nodes %d -> %d (%d new)",
            result["written"],
            result["nodes_before"],
            result["nodes_after"],
            result["created"],
        )
        _print_verification(store)
    finally:
        store.close()


if __name__ == "__main__":
    main()
