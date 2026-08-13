#!/usr/bin/env python3
"""Extract bounded PDF text as JSON in an isolated subprocess."""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from pathlib import Path


class PdfSafetyLimitError(ValueError):
    pass


class Utf8BoundedWriter:
    def __init__(self, output, max_bytes: int):
        self.output = output
        self.max_bytes = max_bytes
        self.bytes_written = 0

    def write(self, value: str) -> int:
        encoded = value.encode("utf-8")
        if self.bytes_written + len(encoded) > self.max_bytes:
            raise PdfSafetyLimitError(
                f"PDF worker output exceeded the {self.max_bytes}-byte safety limit"
            )
        self.output.write(encoded)
        self.bytes_written += len(encoded)
        return len(value)

    def flush(self) -> None:
        self.output.flush()


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("limit must be a positive integer")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract bounded PDF text as JSON")
    parser.add_argument("pdf_path", type=Path)
    parser.add_argument("--max-pages", type=positive_int, required=True)
    parser.add_argument("--max-page-text-bytes", type=positive_int, required=True)
    parser.add_argument("--max-total-text-bytes", type=positive_int, required=True)
    parser.add_argument("--max-output-bytes", type=positive_int, required=True)
    parser.add_argument("--memory-bytes", type=positive_int, required=True)
    parser.add_argument("--cpu-seconds", type=positive_int, required=True)
    return parser.parse_args()


def apply_resource_limits(*, memory_bytes: int, cpu_seconds: int, output_bytes: int):
    try:
        import resource
    except ImportError as error:  # pragma: no cover - the product runtime is macOS/POSIX
        raise PdfSafetyLimitError("PDF resource limits are unavailable on this platform") from error

    def lower_limit(kind: int, soft: int, hard: int | None = None) -> None:
        current_soft, current_hard = resource.getrlimit(kind)
        desired_hard = hard if hard is not None else soft
        if current_hard != resource.RLIM_INFINITY:
            desired_hard = min(desired_hard, current_hard)
        desired_soft = min(soft, desired_hard)
        if current_soft != resource.RLIM_INFINITY:
            desired_soft = min(desired_soft, current_soft)
        resource.setrlimit(kind, (desired_soft, desired_hard))

    lower_limit(resource.RLIMIT_CPU, cpu_seconds, cpu_seconds + 1)
    lower_limit(resource.RLIMIT_FSIZE, output_bytes)
    memory_limited = False
    for limit_name in ("RLIMIT_AS", "RLIMIT_DATA"):
        if not hasattr(resource, limit_name):
            continue
        try:
            lower_limit(getattr(resource, limit_name), memory_bytes)
        except (OSError, ValueError):
            continue
        memory_limited = True
        break
    return resource, memory_limited


def start_memory_watchdog(resource_module, memory_bytes: int) -> threading.Event:
    stopped = threading.Event()

    def monitor() -> None:
        while not stopped.wait(0.02):
            usage = resource_module.getrusage(resource_module.RUSAGE_SELF).ru_maxrss
            rss_bytes = int(usage if sys.platform == "darwin" else usage * 1024)
            if rss_bytes <= memory_bytes:
                continue
            message = (
                "PDF extraction exceeded the "
                f"{memory_bytes}-byte worker memory safety limit\n"
            ).encode("utf-8")
            try:
                os.write(2, message)
            finally:
                os._exit(4)

    threading.Thread(target=monitor, name="pdf-memory-watchdog", daemon=True).start()
    return stopped


def normalize_text(value: str) -> str:
    return (
        (value or "")
        .replace("\u00a0", " ")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .strip()
    )


def extract(args: argparse.Namespace) -> dict:
    # Import only after limits are active so parser initialization is bounded too.
    from pypdf import PdfReader

    pdf_path = args.pdf_path.expanduser().resolve()
    reader = PdfReader(str(pdf_path))
    if getattr(reader, "is_encrypted", False):
        try:
            reader.decrypt("")
        except Exception as error:
            raise ValueError(f"encrypted PDF cannot be read: {error}") from error

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
    total_text_bytes = 0
    for index, page in enumerate(reader.pages, start=1):
        if index > args.max_pages:
            raise PdfSafetyLimitError(
                f"PDF exceeds the {args.max_pages}-page extraction safety limit"
            )
        try:
            text = normalize_text(page.extract_text() or "")
        except MemoryError:
            raise
        except Exception:
            text = ""
        page_bytes = len(text.encode("utf-8"))
        if page_bytes > args.max_page_text_bytes:
            raise PdfSafetyLimitError(
                "PDF page "
                f"{index} exceeded the {args.max_page_text_bytes}-byte per-page text safety limit"
            )
        total_text_bytes += page_bytes
        if total_text_bytes > args.max_total_text_bytes:
            raise PdfSafetyLimitError(
                "PDF extracted text exceeded the "
                f"{args.max_total_text_bytes}-byte aggregate safety limit"
            )
        pages.append({"page": index, "text": text})

    return {
        "title": clean_metadata.get("title") or pdf_path.stem,
        "metadata": clean_metadata,
        "pages": pages,
    }


def main() -> int:
    args = parse_args()
    watchdog_stop = None
    try:
        resource_module, _kernel_memory_limit = apply_resource_limits(
            memory_bytes=args.memory_bytes,
            cpu_seconds=args.cpu_seconds,
            output_bytes=args.max_output_bytes,
        )
        watchdog_stop = start_memory_watchdog(resource_module, args.memory_bytes)
        payload = extract(args)
        writer = Utf8BoundedWriter(sys.stdout.buffer, args.max_output_bytes)
        json.dump(payload, writer, ensure_ascii=False, separators=(",", ":"))
        writer.write("\n")
        writer.flush()
        return 0
    except PdfSafetyLimitError as error:
        print(f"PDF extraction rejected by safety limit: {error}", file=sys.stderr)
        return 4
    except MemoryError:
        print("PDF extraction exceeded the worker memory safety limit", file=sys.stderr)
        return 4
    except Exception as error:
        print(f"PDF extraction failed: {error}", file=sys.stderr)
        return 3
    finally:
        if watchdog_stop is not None:
            watchdog_stop.set()


if __name__ == "__main__":
    raise SystemExit(main())
