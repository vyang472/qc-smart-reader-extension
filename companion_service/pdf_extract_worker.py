#!/usr/bin/env python3
"""Extract PDF text as JSON.

This worker is intentionally separate from server.py so it can run under the
bundled Python runtime where pypdf/pdf dependencies are installed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from pypdf import PdfReader


def normalize_text(value: str) -> str:
    return (
        (value or "")
        .replace("\u00a0", " ")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .strip()
    )


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: pdf_extract_worker.py /path/to/file.pdf", file=sys.stderr)
        return 2

    pdf_path = Path(sys.argv[1]).expanduser().resolve()
    reader = PdfReader(str(pdf_path))
    if getattr(reader, "is_encrypted", False):
        try:
            reader.decrypt("")
        except Exception as error:
            print(f"encrypted PDF cannot be read: {error}", file=sys.stderr)
            return 3

    metadata = reader.metadata or {}
    clean_metadata = {
        "title": normalize_text(str(metadata.get("/Title") or "")),
        "author": normalize_text(str(metadata.get("/Author") or "")),
        "subject": normalize_text(str(metadata.get("/Subject") or "")),
        "creator": normalize_text(str(metadata.get("/Creator") or "")),
        "producer": normalize_text(str(metadata.get("/Producer") or "")),
        "created": normalize_text(str(metadata.get("/CreationDate") or "")),
        "modified": normalize_text(str(metadata.get("/ModDate") or "")),
    }

    pages = []
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = normalize_text(page.extract_text() or "")
        except Exception:
            text = ""
        pages.append({"page": index, "text": text})

    print(
        json.dumps(
            {
                "title": clean_metadata.get("title") or pdf_path.stem,
                "metadata": clean_metadata,
                "pages": pages,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
