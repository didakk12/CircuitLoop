import json
from pathlib import Path

import faiss
import numpy as np

from sentence_transformers import SentenceTransformer

PROJECT_ROOT = Path(__file__).resolve().parent.parent

def main():
    model = SentenceTransformer(
        "sentence-transformers/all-MiniLM-L6-v2"
    )

    index = faiss.read_index(
        str(PROJECT_ROOT / "vector_db" / "circuitloop.index")
    )

    with open(
        PROJECT_ROOT / "data" / "metadata.json",
        "r",
        encoding="utf-8"
    ) as f:
        metadata = json.load(f)

    query = input("Question: ")

    query_embedding = model.encode(
        query,
        convert_to_numpy=True,
        normalize_embeddings=True,
    ).astype("float32")

    _, indices = index.search(
        np.array([query_embedding]),
        k=min(5, index.ntotal)
    )

    print("\nTop Results:\n")

    for idx in indices[0]:
        chunk = metadata[idx]

        print("=" * 60)
        print(f"Part: {chunk['part_name']}")
        print(f"Section: {chunk['section']}")
        print()
        print(chunk["text"][:1000])


if __name__ == "__main__":
    main()