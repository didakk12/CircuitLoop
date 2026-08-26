from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse
from pathlib import Path

import json
import faiss
import numpy as np

from sentence_transformers import SentenceTransformer
import uvicorn

app = FastAPI()

SEARCH_PAGE = """<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>CircuitLoop Search</title>
    <style>
        :root { color-scheme: light; font-family: Segoe UI, sans-serif; }
        body { margin: 0; background: #eef2f3; color: #182326; }
        main { max-width: 900px; margin: 0 auto; padding: 56px 20px; }
        h1 { margin-bottom: 8px; font-size: 2.2rem; }
        .intro { color: #526064; margin-bottom: 28px; }
        form { display: flex; gap: 10px; margin-bottom: 28px; }
        input { flex: 1; min-width: 0; padding: 14px 16px; border: 1px solid #aab8ba; border-radius: 6px; font-size: 1rem; }
        button { border: 0; border-radius: 6px; padding: 0 22px; background: #0b6e69; color: white; font-weight: 700; cursor: pointer; }
        button:hover { background: #095652; }
        #status { color: #526064; }
        article { background: white; border-left: 4px solid #e09f3e; padding: 18px 20px; margin-top: 14px; box-shadow: 0 2px 8px #18323812; }
        article h2 { margin: 0 0 8px; font-size: 1rem; }
        article p { white-space: pre-wrap; line-height: 1.5; margin-bottom: 0; }
        .source { color: #526064; font-size: .9rem; }
        @media (max-width: 600px) { form { flex-direction: column; } button { min-height: 46px; } }
    </style>
</head>
<body>
    <main>
        <h1>CircuitLoop</h1>
        <p class="intro">Search component and datasheet knowledge using semantic retrieval.</p>
        <form id="search-form">
            <input id="query" name="query" placeholder="Ask about a component or datasheet..." required>
            <button type="submit">Search</button>
        </form>
        <div id="status">Enter a question to search the indexed datasheets.</div>
        <section id="results"></section>
    </main>
    <script>
        const form = document.getElementById('search-form');
        const query = document.getElementById('query');
        const status = document.getElementById('status');
        const results = document.getElementById('results');
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            status.textContent = 'Searching...';
            results.replaceChildren();
            try {
                const response = await fetch('/search?query=' + encodeURIComponent(query.value));
                if (!response.ok) throw new Error('Search request failed');
                const data = await response.json();
                status.textContent = data.results.length + ' matching chunks found';
                data.results.forEach((item) => {
                    const article = document.createElement('article');
                    article.innerHTML = '<h2>' + item.part_name + ' | ' + item.section + '</h2>'
                        + '<div class="source">Source: ' + item.source_file + '</div>';
                    const text = document.createElement('p');
                    text.textContent = item.text;
                    article.appendChild(text);
                    results.appendChild(article);
                });
            } catch (error) {
                status.textContent = error.message;
            }
        });
    </script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
def home():
        return SEARCH_PAGE

PROJECT_ROOT = Path(__file__).resolve().parent

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

@app.get("/search")
def search(query: str = Query(min_length=1)):

    query_embedding = model.encode(
        query,
        convert_to_numpy=True,
        normalize_embeddings=True,
    ).astype("float32")

    D, I = index.search(
        np.array([query_embedding]),
        k=min(3, index.ntotal)
    )

    results = []

    for idx in I[0]:

        if idx < 0:
            continue

        results.append(
            metadata[idx]
        )

    return {
        "query": query,
        "results": results
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)