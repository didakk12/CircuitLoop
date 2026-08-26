import json
from pathlib import Path

import faiss
import numpy as np
from sentence_transformers import SentenceTransformer

from schemas import AssistantResponse


PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAG_ROOT = PROJECT_ROOT / "rag"
INDEX_FILE = RAG_ROOT / "vector_db" / "circuitloop.index"
METADATA_FILE = RAG_ROOT / "data" / "metadata.json"

_rag_resources = None


def _load_rag_resources():
    global _rag_resources

    if _rag_resources is None:
        with METADATA_FILE.open("r", encoding="utf-8") as metadata_file:
            metadata = json.load(metadata_file)
        _rag_resources = (
            SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2"),
            faiss.read_index(str(INDEX_FILE)),
            metadata,
        )

    return _rag_resources


def answer_question(component_id: int, question: str) -> AssistantResponse:
    try:
        model, index, metadata = _load_rag_resources()
        query_embedding = model.encode(
            question,
            convert_to_numpy=True,
            normalize_embeddings=True,
        ).astype("float32")
        _, indices = index.search(
            np.array([query_embedding]),
            k=min(3, index.ntotal),
        )
        results = [metadata[index_id] for index_id in indices[0] if index_id >= 0]
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        return AssistantResponse(
            component_id=component_id,
            configured=False,
            message=f"RAG assistant is unavailable: {error}",
        )

    if not results:
        message = "No relevant datasheet information was found."
    else:
        context = "\n\n".join(
            f"{result['part_name']} | {result['section']}\n{result['text']}"
            for result in results
        )
        message = f"Relevant datasheet information:\n\n{context}"

    return AssistantResponse(component_id=component_id, configured=True, message=message)
