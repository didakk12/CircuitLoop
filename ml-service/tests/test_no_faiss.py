"""
Guard tests for the FAISS -> Neo4j migration.

These assert the *absence* of the old architecture. Without them the failure
mode is silent: someone reintroduces a FAISS import or a stray index file as a
"fallback", and the corpus quietly has two sources of truth again — exactly
what the migration set out to eliminate.

Written as repository-level checks rather than behavioural ones because
"there is no second retrieval path" is a property of the tree, not of any one
function's output.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

ML_SERVICE_ROOT = Path(__file__).resolve().parent.parent

# Files that legitimately mention FAISS in prose — module docstrings and
# comments explaining what was replaced and why. Historical context is worth
# keeping; an *import* or a live code path is not.
PYTHON_SOURCES = sorted(
    path
    for path in ML_SERVICE_ROOT.rglob("*.py")
    if ".venv" not in path.parts and "__pycache__" not in path.parts
)


def _imported_module_roots(path: Path) -> set[str]:
    """Top-level package names this file imports, via AST rather than text
    search — so the word 'faiss' inside a docstring is not mistaken for a
    dependency."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                roots.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.level == 0:
                roots.add(node.module.split(".")[0])
    return roots


def test_no_module_imports_faiss():
    offenders = [
        path.relative_to(ML_SERVICE_ROOT).as_posix()
        for path in PYTHON_SOURCES
        if "faiss" in _imported_module_roots(path)
    ]
    assert offenders == [], f"FAISS is still imported by: {offenders}"


def test_faiss_is_not_a_declared_dependency():
    """Checks actual dependency declarations, not prose: both manifests carry a
    comment recording that faiss-cpu was replaced by neo4j, and that note is
    worth keeping."""
    requirement_lines = [
        line.split("#", 1)[0].strip()
        for line in (ML_SERVICE_ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
    ]
    declared = [line for line in requirement_lines if line]
    assert not any("faiss" in line.lower() for line in declared), (
        f"requirements.txt still declares FAISS: {[l for l in declared if 'faiss' in l.lower()]}"
    )

    import tomllib

    pyproject = tomllib.loads((ML_SERVICE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    project = pyproject["project"]
    all_dependencies = list(project.get("dependencies", []))
    for extra in project.get("optional-dependencies", {}).values():
        all_dependencies.extend(extra)
    assert not any("faiss" in dependency.lower() for dependency in all_dependencies), (
        f"pyproject.toml still declares FAISS: {all_dependencies}"
    )

    # And the replacement is actually declared, in both places.
    assert any("neo4j" in line.lower() for line in declared)
    assert any("neo4j" in dependency.lower() for dependency in all_dependencies)


def test_faiss_index_artifacts_are_gone():
    """The prebuilt index and its parallel metadata copy. While these exist,
    someone can point code back at them."""
    assert not (ML_SERVICE_ROOT / "vector_db").exists(), "ml-service/vector_db/ still exists"
    assert not (ML_SERVICE_ROOT / "data" / "embeddings.npy").exists()
    # The runtime metadata lookup table that FAISS row numbers indexed into.
    assert not (ML_SERVICE_ROOT / "data" / "metadata.json").exists()


def test_faiss_index_build_script_is_gone():
    assert not (ML_SERVICE_ROOT / "pipeline" / "build_faiss_index.py").exists()


def test_retrieval_path_goes_through_neo4j():
    """search.py must reach the corpus via neo4j_store and nothing else."""
    imports = _imported_module_roots(ML_SERVICE_ROOT / "search.py")

    assert "neo4j_store" in imports
    assert "faiss" not in imports
    # No file-backed corpus loading left in the retrieval module.
    source = (ML_SERVICE_ROOT / "search.py").read_text(encoding="utf-8")
    assert "read_index" not in source
    assert "metadata.json" not in source.replace("`data/metadata.json`", "")


def test_ingestion_writes_to_neo4j_not_a_file_index():
    source = (ML_SERVICE_ROOT / "pipeline" / "ingest.py").read_text(encoding="utf-8")
    imports = _imported_module_roots(ML_SERVICE_ROOT / "pipeline" / "ingest.py")

    assert "neo4j_store" in imports
    assert "faiss" not in imports
    assert "write_index" not in source


@pytest.mark.parametrize("module_name", ["neo4j_store", "search"])
def test_rag_modules_import_cleanly_without_faiss_installed(module_name):
    """Import the real modules: if any of them still needed faiss, this would
    raise ImportError once the package is uninstalled from the environment."""
    __import__(module_name)
