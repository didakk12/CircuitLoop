import json
from pathlib import Path

import faiss
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parent.parent
EMBEDDINGS_FILE = PROJECT_ROOT / "data" / "embeddings.npy"
INPUT_METADATA = PROJECT_ROOT / "data" / "metadata.json"
OUTPUT_DIRECTORY = PROJECT_ROOT / "vector_db"
OUTPUT_INDEX = OUTPUT_DIRECTORY / "circuitloop.index"
OUTPUT_METADATA = OUTPUT_DIRECTORY / "metadata.json"

if not EMBEDDINGS_FILE.exists() or not INPUT_METADATA.exists():
    raise SystemExit("Run scripts/create_embeddings.py before building the FAISS index")

embeddings = np.load(
    EMBEDDINGS_FILE
).astype("float32")

if embeddings.ndim != 2 or embeddings.shape[0] == 0:
    raise SystemExit(f"Expected a non-empty 2D embedding array, got shape {embeddings.shape}")

with open(INPUT_METADATA, "r", encoding="utf-8") as f:
    metadata = json.load(f)

if len(metadata) != embeddings.shape[0]:
    raise SystemExit("Embedding and metadata counts do not match")

dimension = embeddings.shape[1]

index = faiss.IndexFlatL2(
    dimension
)

index.add(
    embeddings
)

OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)

faiss.write_index(
    index,
    str(OUTPUT_INDEX)
)

with open(OUTPUT_METADATA, "w", encoding="utf-8") as f:
    json.dump(metadata, f, indent=2, ensure_ascii=False)

print(
    f"Saved FAISS index with "
    f"{index.ntotal} vectors"
)