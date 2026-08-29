"""
Manual retrieval spot-check against the live Neo4j vector index.

A developer convenience for eyeballing what the corpus actually returns for
a phrasing -- not part of the automated suite (see tests/ for that) and not
imported by the service. Previously it opened the FAISS index and the
parallel metadata.json directly; it now goes through the same `SearchService`
the /search endpoint uses, so what it prints is exactly what the API would
return, scores included.

    python pipeline/test_search.py
    python pipeline/test_search.py "esd rating" --top-k 5
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from config import MISSING_NEO4J_MESSAGE, load_neo4j_settings  # noqa: E402
from neo4j_store import RagStore  # noqa: E402
from search import SearchService  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Query the Neo4j-backed RAG corpus")
    parser.add_argument("query", nargs="?", help="Question to search for (prompted if omitted)")
    parser.add_argument("--top-k", type=int, default=5)
    args = parser.parse_args()

    # Keep the model-loading chatter out of the way of the results.
    logging.basicConfig(level=logging.WARNING)

    neo4j_settings = load_neo4j_settings()
    if neo4j_settings is None:
        raise SystemExit(MISSING_NEO4J_MESSAGE)

    store = RagStore(
        uri=neo4j_settings.uri,
        username=neo4j_settings.username,
        password=neo4j_settings.password,
        database=neo4j_settings.database,
    )
    service = SearchService(store=store)
    service.load()
    try:
        query = args.query or input("Question: ")
        results = service.search(query, top_k=args.top_k)

        if not results:
            print("\nNo results.")
            return

        print(f"\nTop {len(results)} results:\n")
        for result in results:
            print("=" * 70)
            print(f"Score:   {result.score:.4f}")
            print(f"Part:    {result.part_name}")
            print(f"Section: {result.section}")
            print(f"Source:  {result.source_file}")
            print()
            print(result.text[:1000])
            print()
    finally:
        service.close()


if __name__ == "__main__":
    main()
