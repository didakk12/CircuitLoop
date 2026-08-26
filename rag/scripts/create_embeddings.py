import json
from pathlib import Path

import numpy as np

from sentence_transformers import SentenceTransformer

PROJECT_ROOT = Path(__file__).resolve().parent.parent
INPUT_FILE = PROJECT_ROOT / "data" / "chunks.json"
OUTPUT_EMBEDDINGS = PROJECT_ROOT / "data" / "embeddings.npy"
OUTPUT_METADATA = PROJECT_ROOT / "data" / "metadata.json"

model = SentenceTransformer(
    "sentence-transformers/all-MiniLM-L6-v2"
)

with open(INPUT_FILE, "r", encoding="utf-8") as f:
    chunks = json.load(f)

if not chunks:
    raise SystemExit(f"No chunks found in {INPUT_FILE}")

if any(not isinstance(chunk.get("text"), str) or not chunk["text"].strip() for chunk in chunks):
    raise SystemExit("Every chunk must contain non-empty text")

texts = [chunk["text"] for chunk in chunks]

print(f"Generating embeddings for {len(texts)} chunks...")

embeddings = model.encode(
    texts,
    show_progress_bar=True,
    convert_to_numpy=True,
    normalize_embeddings=True,
)

np.save(
    OUTPUT_EMBEDDINGS,
    embeddings
)

with open(
    OUTPUT_METADATA,
    "w",
    encoding="utf-8"
) as f:
    json.dump(
        chunks,
        f,
        indent=2,
        ensure_ascii=False
    )

print("Embeddings saved.")