import argparse
import json
import re
from pathlib import Path

import pdfplumber

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# ==========================
# CONFIGURATION
# ==========================

MAX_CHUNK_SIZE = 1200

SECTION_HEADERS = [
    "description",
    "overview",
    "features",
    "applications",
    "pin configuration",
    "pin description",
    "pin assignments",
    "pin information",
    "absolute maximum ratings",
    "electrical characteristics",
    "electrical specifications",
    "recommended operating conditions",
    "thermal information",
    "typical application",
    "functional description",
    "theory of operation",
    "ordering information",
    "block diagram",
]

HEADER_PATTERN = re.compile(
    r"^\s*(\d+(\.\d+)*)?\s*(.*?)\s*$",
    re.IGNORECASE
)

# ==========================
# PDF EXTRACTION
# ==========================

def extract_text_by_page(pdf_path: Path):
    pages = []

    with pdfplumber.open(pdf_path) as pdf:

        for page in pdf.pages:

            page_text = page.extract_text() or ""

            try:
                tables = page.extract_tables()

                table_text = ""

                for table in tables:
                    for row in table:
                        cleaned = [
                            str(cell).strip()
                            if cell is not None
                            else ""
                            for cell in row
                        ]

                        table_text += " | ".join(cleaned) + "\n"

                page_text += "\n" + table_text

            except Exception:
                pass

            pages.append(page_text)

    return pages

# ==========================
# PART NUMBER EXTRACTION
# ==========================

def guess_part_name(pdf_path: Path, first_page_text: str):

    stem = pdf_path.stem

    tokens = re.split(r"[_\-\s]", stem)

    for tok in tokens:

        if any(c.isdigit() for c in tok) and len(tok) >= 4:
            return tok.upper()

    for line in first_page_text.split("\n"):

        line = line.strip()

        if line:
            return line[:60]

    return stem

# ==========================
# HEADER DETECTION
# ==========================

def is_section_header(line):

    line = line.strip()

    if not line:
        return None

    match = HEADER_PATTERN.match(line)

    if not match:
        return None

    candidate = match.group(3).lower()

    for header in SECTION_HEADERS:

        if header in candidate:
            return header

    return None

# ==========================
# CHUNK CREATION
# ==========================

def split_large_text(
    text,
    part_name,
    section,
    source_file,
):

    chunks = []

    chunk_index = 0

    for start in range(0, len(text), MAX_CHUNK_SIZE):

        chunk_text = text[start:start + MAX_CHUNK_SIZE].strip()

        if not chunk_text:
            continue

        chunks.append({
            "chunk_id": f"{part_name}_{section}_{chunk_index}",
            "part_name": part_name,
            "section": section,
            "source_file": source_file,
            "text": chunk_text
        })

        chunk_index += 1

    return chunks

# ==========================
# SECTION CHUNKING
# ==========================

def chunk_by_section(
    full_text,
    part_name,
    source_file,
):

    lines = full_text.split("\n")

    chunks = []

    current_section = "general"

    current_lines = []

    for line in lines:

        detected_header = is_section_header(line)

        if detected_header:

            if current_lines:

                section_text = "\n".join(
                    current_lines
                ).strip()

                chunks.extend(
                    split_large_text(
                        section_text,
                        part_name,
                        current_section,
                        source_file
                    )
                )

            current_section = detected_header
            current_lines = []

        else:
            current_lines.append(line)

    if current_lines:

        section_text = "\n".join(
            current_lines
        ).strip()

        chunks.extend(
            split_large_text(
                section_text,
                part_name,
                current_section,
                source_file
            )
        )

    if len(chunks) <= 1:

        chunks = split_large_text(
            full_text,
            part_name,
            "general",
            source_file
        )

    return chunks

# ==========================
# PROCESS ALL PDFS
# ==========================

def process_folder(input_dir: Path):

    all_chunks = []

    pdf_files = sorted(
        input_dir.glob("*.pdf")
    )

    if not pdf_files:
        print(f"No PDFs found in {input_dir}")
        return all_chunks

    for pdf_path in pdf_files:

        print(f"Processing {pdf_path.name}")

        try:

            pages = extract_text_by_page(pdf_path)

        except Exception as e:

            print(
                f"Failed to read {pdf_path.name}: {e}"
            )

            continue

        full_text = "\n".join(pages)

        if not full_text.strip():

            print(
                f"No extractable text in {pdf_path.name}"
            )

            continue

        part_name = guess_part_name(
            pdf_path,
            pages[0] if pages else ""
        )

        chunks = chunk_by_section(
            full_text,
            part_name,
            pdf_path.name
        )

        print(
            f"  -> {len(chunks)} chunks "
            f"(part={part_name})"
        )

        all_chunks.extend(chunks)

    return all_chunks

# ==========================
# MAIN
# ==========================

def main():

    parser = argparse.ArgumentParser(
        description="Datasheet Chunk Generator for CircuitLoop RAG"
    )

    parser.add_argument(
        "--input",
        required=True,
        help="Folder containing datasheet PDFs"
    )

    parser.add_argument(
        "--output",
        default=str(PROJECT_ROOT / "data" / "chunks.json"),
        help="Output JSON file"
    )

    args = parser.parse_args()

    input_dir = Path(args.input)

    if not input_dir.exists():
        raise SystemExit(
            f"Folder not found: {input_dir}"
        )

    chunks = process_folder(input_dir)

    output_file = Path(args.output)
    if not output_file.is_absolute():
        output_file = PROJECT_ROOT / output_file

    output_file.parent.mkdir(parents=True, exist_ok=True)

    with open(
        output_file,
        "w",
        encoding="utf-8"
    ) as f:

        json.dump(
            chunks,
            f,
            indent=2,
            ensure_ascii=False
        )

    print(
        f"\nDone! "
        f"{len(chunks)} chunks saved to "
        f"{output_file}"
    )

if __name__ == "__main__":
    main()
    