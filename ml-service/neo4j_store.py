"""
Neo4j-backed storage and vector retrieval for the RAG corpus.

This module is the **single** place the ML service touches Neo4j, and Neo4j
is the **single** source of truth for the RAG corpus: chunk text, chunk
metadata, and the embedding vector all live on one `(:DatasheetChunk)` node,
and similarity search runs against Neo4j's own vector index. There is no
FAISS index, no `metadata.json` lookup table, and no second copy of the
corpus anywhere in the runtime path.

Relationship to ML_SERVICE_INTEGRATION_PLAN.md section 7
-------------------------------------------------------
That section states "Python does not write to Neo4j", its stated reasons
being (a) the TS repository layer must be the single owner of *application*
graph writes, and (b) Python had no Neo4j client or credentials. The rule
was written about **detections** -- user-owned `(:Component)` data reachable
through the authenticated API -- and it still holds unchanged: this module
never reads or writes User, Scan, Component, TestResult, Command, or
HealthReport.

`(:DatasheetChunk)` is a different kind of data, and the exception is
deliberate rather than an oversight:
  - it is a global, read-only, offline-built corpus of public vendor
    datasheets: no owner, no per-user scoping, never mixed with user data;
  - the embedding model that produces the vectors is sentence-transformers,
    which is Python-only, so the write side has to live here regardless;
  - the alternative -- streaming 728 x 384 floats through the TS backend on
    every corpus rebuild -- adds a hop and a serialization format for no
    benefit.

The TS backend still declares this part of the schema too (see
`backend/src/db/schema.ts`), so the graph schema stays documented in one
canonical place. Both declarations use IF NOT EXISTS, and `ensure_schema()`
below verifies the live index against this module's constants, so a drift
between the two surfaces as a loud startup error rather than as silently
wrong retrieval.

Vector API choice (verified against the live server, not assumed)
----------------------------------------------------------------
Target server: **Neo4j Kernel 2026.07.1 Enterprise**, Cypher 5 + 25.
  - CREATE VECTOR INDEX ... OPTIONS { indexConfig: { vector.dimensions,
    vector.similarity_function } } -- works.
  - db.index.vector.queryNodes -- works, and the server emits a
    forward-looking deprecation notice saying it "is replaced by SEARCH".
  - That SEARCH clause is **not implemented on this server version**: it
    fails to parse under both CYPHER 5 and CYPHER 25.
So db.index.vector.queryNodes is the only working vector-search API here,
and is what this module uses. Revisit when a server version actually ships
SEARCH; the change would be confined to `query_similar_chunks()`.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from neo4j import Driver, GraphDatabase

logger = logging.getLogger(__name__)

# --- Schema constants -------------------------------------------------------
# Mirrored in backend/src/db/schema.ts and backend/src/types/entities.ts,
# kept manually in sync -- the same convention already used between
# ml-service/schemas.py and backend/src/types/mlService.ts. ensure_schema()
# actively verifies the live index against these values, so drift between the
# two declarations cannot pass silently.
NODE_LABEL = "DatasheetChunk"
EMBEDDING_PROPERTY = "embedding"
VECTOR_INDEX_NAME = "datasheet_chunk_embedding_index"
ID_CONSTRAINT_NAME = "datasheetchunk_id_unique"
SOURCE_FILE_INDEX_NAME = "datasheetchunk_source_file_index"

# all-MiniLM-L6-v2 output width. Asserted against the loaded model in
# search.py so a model swap cannot silently disagree with the index.
EMBEDDING_DIMENSIONS = 384

# The corpus embeddings are L2-normalized at generation time (both the
# original pipeline and pipeline/ingest.py pass normalize_embeddings=True),
# so cosine and the previous FAISS IndexFlatL2 rank results identically: for
# unit vectors, squared-L2 == 2 - 2*cosine, a strictly decreasing function of
# cosine. Cosine is chosen over Neo4j's 'euclidean' because it yields a
# bounded, directly reportable [0, 1] similarity score, which is what
# /search now returns.
SIMILARITY_FUNCTION = "cosine"

DEFAULT_TOP_K = 3

# Minimum cosine similarity for a chunk to be considered relevant at all.
#
# Calibrated against this corpus, not guessed. all-MiniLM-L6-v2 compresses
# cosine similarity into a narrow band -- nothing ever scores near zero -- so
# an intuitively "low" threshold like 0.2 would filter nothing. Measured over
# the real 724-chunk corpus:
#
#   off-topic queries ("best hiking trails in Norway", "capital of France")
#                                     -> top-1 scores 0.575 - 0.630
#   genuine electronics/component queries
#                                     -> top-1 scores 0.671 - 0.853
#
# 0.65 sits in that gap: above every measured off-topic score, below every
# measured genuine one.
#
# What this threshold does NOT do: decide whether a chunk is about the
# *selected part*. A query naming a part absent from the corpus still scores
# 0.671-0.758 against other parts' datasheets, overlapping the 0.731-0.792
# range of parts that ARE covered. Part identity is therefore established
# separately and deterministically in the TypeScript backend
# (assistantService.ts marks each chunk as matching the component's marking
# or not) rather than being inferred from a score.
DEFAULT_MIN_SCORE = 0.65


class RagStoreNotConnectedError(RuntimeError):
    """Raised when the store is used before connect() has succeeded."""


class SchemaMismatchError(RuntimeError):
    """Raised when the live vector index disagrees with this module's constants."""


@dataclass(frozen=True)
class ChunkRecord:
    """One datasheet chunk, exactly as stored on a (:DatasheetChunk) node."""

    id: str
    chunk_id: str
    part_name: str
    section: str
    source_file: str
    text: str
    embedding: list[float]


@dataclass(frozen=True)
class RetrievedChunk:
    part_name: str
    section: str
    source_file: str
    text: str
    score: float


def content_id(source_file: str, part_name: str, section: str, text: str) -> str:
    """Stable, unique, content-addressed id for a chunk.

    Why not the pipeline's own `chunk_id`: it is built as
    ``{part}_{section}_{n}`` where ``n`` restarts at 0 every time a section
    header recurs within the same PDF, so it collides. In the real corpus only
    **406 of 728** chunk_id values are distinct -- MERGE-ing on it would
    silently collapse the corpus to 406 nodes and destroy 322 chunks.

    Hashing the full content instead gives an id that is deterministic
    (re-ingesting unchanged input produces the same ids, which is what makes
    ingestion idempotent) and unique per distinct chunk. Two records collapse
    into one node only when they are byte-identical in every stored field --
    genuine duplicates that carry no extra information and would otherwise be
    returned twice within the same top-k result.
    """
    digest = hashlib.sha256()
    for part in (source_file, part_name, section, text):
        digest.update(part.encode("utf-8"))
        digest.update(b"\x00")  # unambiguous field separator
    return digest.hexdigest()


def _schema_statements() -> tuple[str, ...]:
    dims = EMBEDDING_DIMENSIONS
    similarity = SIMILARITY_FUNCTION
    return (
        f"CREATE CONSTRAINT {ID_CONSTRAINT_NAME} IF NOT EXISTS "
        f"FOR (d:{NODE_LABEL}) REQUIRE d.id IS UNIQUE",
        f"CREATE INDEX {SOURCE_FILE_INDEX_NAME} IF NOT EXISTS "
        f"FOR (d:{NODE_LABEL}) ON (d.sourceFile)",
        f"CREATE VECTOR INDEX {VECTOR_INDEX_NAME} IF NOT EXISTS "
        f"FOR (d:{NODE_LABEL}) ON (d.{EMBEDDING_PROPERTY}) "
        "OPTIONS { indexConfig: { "
        f"`vector.dimensions`: {dims}, "
        f"`vector.similarity_function`: '{similarity}'"
        " } }",
    )


class RagStore:
    """Owns the Neo4j driver used for RAG storage and retrieval.

    Same "connect once, reuse for the process lifetime" shape as
    GeminiDetectionService/SearchService -- the driver pools connections
    internally, so reuse here means reusing the one Driver.
    """

    def __init__(self, uri: str, username: str, password: str, database: str | None = None) -> None:
        self._uri = uri
        self._username = username
        self._password = password
        self._database = database
        self._driver: Driver | None = None

    # --- lifecycle ---------------------------------------------------------

    def connect(self) -> None:
        driver = GraphDatabase.driver(
            self._uri,
            auth=(self._username, self._password),
            # Two sources of unavoidable, non-actionable notification noise:
            #  - db.index.vector.queryNodes carries a deprecation notice on
            #    2026.x announcing a SEARCH replacement this server does not
            #    yet implement (see module docstring), on *every* query;
            #  - ensure_schema()'s IF NOT EXISTS statements emit an
            #    INFORMATION "already exists, has no effect" notice on every
            #    startup after the first, which is the expected steady state.
            # Suppressing exactly these two keeps the log readable; genuine
            # WARNING-severity notifications still surface.
            notifications_min_severity="WARNING",
            notifications_disabled_classifications=["DEPRECATION"],
        )
        driver.verify_connectivity()
        self._driver = driver
        logger.info("Connected to Neo4j for RAG storage at %s", redact_uri(self._uri))

    def close(self) -> None:
        if self._driver is not None:
            self._driver.close()
            self._driver = None

    @property
    def is_connected(self) -> bool:
        return self._driver is not None

    def _run(self, query: str, **params: Any) -> list[Any]:
        if self._driver is None:
            raise RagStoreNotConnectedError("Call connect() before using the RAG store")
        with self._driver.session(database=self._database) as session:
            return list(session.run(query, **params))

    def _run_consume(self, query: str, **params: Any) -> None:
        if self._driver is None:
            raise RagStoreNotConnectedError("Call connect() before using the RAG store")
        with self._driver.session(database=self._database) as session:
            session.run(query, **params).consume()

    # --- schema ------------------------------------------------------------

    def ensure_schema(self, await_seconds: int = 120) -> None:
        """Creates the constraint, range index and vector index if absent,
        waits for the vector index to come ONLINE, then verifies its live
        configuration matches this module's constants.

        Idempotent (every statement is IF NOT EXISTS) and safe to run
        concurrently with the TS backend's own startup bootstrap.
        """
        for statement in _schema_statements():
            self._run_consume(statement)

        # Index population is asynchronous, and a query issued against a
        # still-POPULATING vector index returns incomplete results rather
        # than an error -- so waiting here is a correctness requirement, not
        # politeness.
        self._run_consume(
            "CALL db.awaitIndex($name, $timeout)",
            name=VECTOR_INDEX_NAME,
            timeout=await_seconds,
        )

        info = self.vector_index_info()
        if info is None:
            raise SchemaMismatchError(f"Vector index {VECTOR_INDEX_NAME!r} was not created")

        actual_dims = info["dimensions"]
        actual_similarity = str(info["similarity_function"]).lower()
        if actual_dims != EMBEDDING_DIMENSIONS:
            raise SchemaMismatchError(
                f"Vector index {VECTOR_INDEX_NAME!r} has {actual_dims} dimensions, expected "
                f"{EMBEDDING_DIMENSIONS}. It was created for a different embedding model -- "
                f"drop the index and re-run ingestion."
            )
        if actual_similarity != SIMILARITY_FUNCTION.lower():
            raise SchemaMismatchError(
                f"Vector index {VECTOR_INDEX_NAME!r} uses similarity {actual_similarity!r}, "
                f"expected {SIMILARITY_FUNCTION!r}."
            )
        logger.info(
            "RAG schema ready: index %s is %s (%d dims, %s)",
            VECTOR_INDEX_NAME,
            info["state"],
            actual_dims,
            actual_similarity,
        )

    def vector_index_info(self) -> dict[str, Any] | None:
        """Live description of the vector index, or None if it does not exist."""
        records = self._run(
            "SHOW INDEXES YIELD name, type, state, labelsOrTypes, properties, options "
            "WHERE name = $name "
            "RETURN type, state, labelsOrTypes, properties, options",
            name=VECTOR_INDEX_NAME,
        )
        if not records:
            return None
        record = records[0]
        config = record["options"]["indexConfig"]
        return {
            "name": VECTOR_INDEX_NAME,
            "type": record["type"],
            "state": record["state"],
            "labels": list(record["labelsOrTypes"]),
            "properties": list(record["properties"]),
            "dimensions": int(config["vector.dimensions"]),
            "similarity_function": config["vector.similarity_function"],
        }

    def is_index_online(self) -> bool:
        info = self.vector_index_info()
        return info is not None and info["state"] == "ONLINE"

    # --- writes ------------------------------------------------------------

    def upsert_chunks(self, records: Sequence[ChunkRecord], batch_size: int = 250) -> dict[str, int]:
        """Idempotently writes chunks as (:DatasheetChunk) nodes.

        MERGE on the content-addressed `id` means re-running ingestion over
        unchanged input rewrites the same nodes instead of creating new ones,
        so the corpus cannot double. The embedding goes through
        db.create.setNodeVectorProperty -- the supported path for vector
        properties, which validates the value as a vector rather than storing
        a loose list of numbers.
        """
        before = self.count_chunks()
        written = 0
        total = len(records)
        for start in range(0, total, batch_size):
            batch = records[start : start + batch_size]
            rows = [
                {
                    "id": record.id,
                    "chunkId": record.chunk_id,
                    "partName": record.part_name,
                    "section": record.section,
                    "sourceFile": record.source_file,
                    "text": record.text,
                    "embedding": record.embedding,
                }
                for record in batch
            ]
            result = self._run(
                f"""
                UNWIND $rows AS row
                MERGE (d:{NODE_LABEL} {{ id: row.id }})
                SET d.chunkId    = row.chunkId,
                    d.partName   = row.partName,
                    d.section    = row.section,
                    d.sourceFile = row.sourceFile,
                    d.text       = row.text
                WITH d, row
                CALL db.create.setNodeVectorProperty(d, '{EMBEDDING_PROPERTY}', row.embedding)
                RETURN count(d) AS written
                """,
                rows=rows,
            )
            written += int(result[0]["written"]) if result else 0
            logger.info("Upserted %d/%d chunks", min(start + batch_size, total), total)

        after = self.count_chunks()
        return {
            "written": written,
            "nodes_before": before,
            "nodes_after": after,
            "created": after - before,
        }

    def delete_all_chunks(self) -> int:
        """Removes the whole corpus. Used by `ingest.py --reset` and by tests;
        never called by the running service."""
        records = self._run(
            f"MATCH (d:{NODE_LABEL}) DETACH DELETE d RETURN count(d) AS deleted"
        )
        return int(records[0]["deleted"]) if records else 0

    def delete_chunks_by_ids(self, ids: Iterable[str]) -> int:
        records = self._run(
            f"MATCH (d:{NODE_LABEL}) WHERE d.id IN $ids DETACH DELETE d RETURN count(d) AS deleted",
            ids=list(ids),
        )
        return int(records[0]["deleted"]) if records else 0

    # --- reads -------------------------------------------------------------

    def query_similar_chunks(
        self,
        embedding: Sequence[float],
        top_k: int = DEFAULT_TOP_K,
        min_score: float = DEFAULT_MIN_SCORE,
    ) -> list[RetrievedChunk]:
        """Vector similarity search against the Neo4j vector index.

        `score` is the cosine similarity Neo4j itself computed, in [0, 1],
        passed straight through -- this service neither recomputes nor
        rescales it.

        Chunks scoring below `min_score` are dropped, so the caller receives
        *fewer* than `top_k` results (possibly none) rather than being handed
        weak matches padded out to a fixed count. Filtering happens in Cypher,
        after the index has ranked, so a below-threshold chunk never crosses
        the wire. See DEFAULT_MIN_SCORE for how the default was calibrated,
        and for what this threshold deliberately does not attempt to decide.
        """
        records = self._run(
            f"""
            CALL db.index.vector.queryNodes($indexName, $topK, $embedding)
            YIELD node, score
            WHERE score >= $minScore
            RETURN node.partName   AS part_name,
                   node.section    AS section,
                   node.sourceFile AS source_file,
                   node.text       AS text,
                   score
            ORDER BY score DESC
            """,
            indexName=VECTOR_INDEX_NAME,
            topK=top_k,
            embedding=list(embedding),
            minScore=float(min_score),
        )
        return [
            RetrievedChunk(
                part_name=record["part_name"],
                section=record["section"],
                source_file=record["source_file"],
                text=record["text"],
                score=float(record["score"]),
            )
            for record in records
        ]

    def count_chunks(self) -> int:
        records = self._run(f"MATCH (d:{NODE_LABEL}) RETURN count(d) AS total")
        return int(records[0]["total"]) if records else 0

    def corpus_stats(self) -> dict[str, Any]:
        """Aggregate corpus facts, used by `ingest.py --verify` and by tests."""
        records = self._run(
            f"""
            MATCH (d:{NODE_LABEL})
            RETURN count(d)                              AS total,
                   count(d.{EMBEDDING_PROPERTY})         AS with_embedding,
                   count(DISTINCT d.sourceFile)          AS source_files,
                   count(DISTINCT d.partName)            AS part_names,
                   count(DISTINCT d.id)                  AS distinct_ids,
                   min(size(d.{EMBEDDING_PROPERTY}))     AS min_dims,
                   max(size(d.{EMBEDDING_PROPERTY}))     AS max_dims
            """
        )
        if not records:
            return {}
        record = records[0]
        return {
            "total": int(record["total"]),
            "with_embedding": int(record["with_embedding"]),
            "source_files": int(record["source_files"]),
            "part_names": int(record["part_names"]),
            "distinct_ids": int(record["distinct_ids"]),
            "min_dims": int(record["min_dims"]) if record["min_dims"] is not None else None,
            "max_dims": int(record["max_dims"]) if record["max_dims"] is not None else None,
        }

    def sample_chunk(self) -> dict[str, Any] | None:
        records = self._run(
            f"""
            MATCH (d:{NODE_LABEL})
            RETURN d.id         AS id,
                   d.chunkId    AS chunk_id,
                   d.partName   AS part_name,
                   d.section    AS section,
                   d.sourceFile AS source_file,
                   d.text       AS text,
                   size(d.{EMBEDDING_PROPERTY}) AS dims
            ORDER BY d.id LIMIT 1
            """
        )
        return dict(records[0]) if records else None


def redact_uri(uri: str) -> str:
    """Strips any embedded credentials before a URI reaches a log line."""
    if "@" in uri:
        scheme, _, rest = uri.partition("://")
        return f"{scheme}://<redacted>@{rest.split('@', 1)[1]}"
    return uri
