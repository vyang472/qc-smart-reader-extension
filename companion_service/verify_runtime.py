#!/usr/bin/env python3
"""Verify companion dependencies against release-owned runtime digests."""

from __future__ import annotations

import base64
import hashlib
import importlib.metadata
import importlib.util
import json
import re
import sys
from pathlib import Path, PurePosixPath


PIN_RE = re.compile(
    r"([A-Za-z0-9][A-Za-z0-9_.-]*)==([A-Za-z0-9][A-Za-z0-9_.+!-]*)"
)
RUNTIME_SUFFIXES = {".py", ".so", ".dylib", ".pyd"}
MANIFEST_SCHEMA_VERSION = 1
CANONICAL_LINE = r"path\0size\0sha256\n"
SHA256_RE = re.compile(r"[0-9a-f]{64}")
IMPORT_NAME_RE = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*")


def normalized_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def read_pins(path: Path) -> list[tuple[str, str]]:
    pins: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        value = raw.strip()
        if not value or value.startswith("#"):
            continue
        match = PIN_RE.fullmatch(value)
        if not match:
            raise ValueError(f"unsupported requirement: {value}")
        name, version = match.groups()
        key = normalized_name(name)
        if key in seen:
            raise ValueError(f"duplicate requirement: {name}")
        seen.add(key)
        pins.append((name, version))
    if not pins:
        raise ValueError("requirements file is empty")
    return pins


def encoded_digest(path: Path, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return base64.urlsafe_b64encode(digest.digest()).rstrip(b"=").decode("ascii")


def sha256_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def exact_keys(value: dict, expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        detail = []
        if missing:
            detail.append(f"missing {', '.join(missing)}")
        if extra:
            detail.append(f"unknown {', '.join(extra)}")
        raise ValueError(f"invalid {label}: {'; '.join(detail)}")


def safe_relative_path(value: object, label: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or any(char in value for char in "\0\r\n"):
        raise ValueError(f"invalid {label}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"unsafe {label}: {value!r}")
    if path.as_posix() != value or "\\" in value:
        raise ValueError(f"non-canonical {label}: {value!r}")
    return path


def load_manifest(path: Path) -> dict[str, dict]:
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"trusted runtime manifest is missing or unsafe: {path}")

    def reject_duplicate_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate runtime manifest key: {key}")
            result[key] = value
        return result

    try:
        payload = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicate_keys)
    except json.JSONDecodeError as error:
        raise ValueError(f"trusted runtime manifest is invalid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError("trusted runtime manifest must be a JSON object")
    exact_keys(payload, {"schema_version", "canonical_line", "distributions"}, "runtime manifest")
    if payload["schema_version"] != MANIFEST_SCHEMA_VERSION:
        raise ValueError("trusted runtime manifest schema version is unsupported")
    if payload["canonical_line"] != CANONICAL_LINE:
        raise ValueError("trusted runtime manifest canonical line contract is invalid")
    distributions = payload["distributions"]
    if not isinstance(distributions, dict) or not distributions:
        raise ValueError("trusted runtime manifest has no distributions")

    parsed = {}
    required_fields = {
        "version",
        "import_name",
        "import_path",
        "runtime_roots",
        "file_count",
        "aggregate_sha256",
    }
    for raw_name, raw_entry in distributions.items():
        if not isinstance(raw_name, str) or normalized_name(raw_name) != raw_name:
            raise ValueError(f"runtime manifest distribution name is not normalized: {raw_name!r}")
        if not isinstance(raw_entry, dict):
            raise ValueError(f"runtime manifest entry must be an object: {raw_name}")
        exact_keys(raw_entry, required_fields, f"runtime manifest entry for {raw_name}")
        version = raw_entry["version"]
        if not isinstance(version, str) or not PIN_RE.fullmatch(f"x=={version}"):
            raise ValueError(f"runtime manifest version is invalid for {raw_name}")
        import_name = raw_entry["import_name"]
        if not isinstance(import_name, str) or not IMPORT_NAME_RE.fullmatch(import_name):
            raise ValueError(f"runtime manifest import name is invalid for {raw_name}")
        import_path = safe_relative_path(raw_entry["import_path"], f"import path for {raw_name}")
        roots = raw_entry["runtime_roots"]
        if not isinstance(roots, list) or not roots:
            raise ValueError(f"runtime manifest roots are missing for {raw_name}")
        parsed_roots = []
        seen_roots = set()
        for root in roots:
            if not isinstance(root, dict):
                raise ValueError(f"runtime root must be an object for {raw_name}")
            exact_keys(root, {"path", "kind"}, f"runtime root for {raw_name}")
            root_path = safe_relative_path(root["path"], f"runtime root for {raw_name}")
            kind = root["kind"]
            if kind not in {"file", "directory"}:
                raise ValueError(f"runtime root kind is invalid for {raw_name}")
            if root_path.as_posix() in seen_roots:
                raise ValueError(f"duplicate runtime root for {raw_name}: {root_path}")
            seen_roots.add(root_path.as_posix())
            parsed_roots.append({"path": root_path, "kind": kind})
        file_count = raw_entry["file_count"]
        if isinstance(file_count, bool) or not isinstance(file_count, int) or file_count <= 0:
            raise ValueError(f"runtime manifest file count is invalid for {raw_name}")
        aggregate = raw_entry["aggregate_sha256"]
        if not isinstance(aggregate, str) or not SHA256_RE.fullmatch(aggregate):
            raise ValueError(f"runtime manifest aggregate is invalid for {raw_name}")
        parsed[raw_name] = {
            "version": version,
            "import_name": import_name,
            "import_path": import_path,
            "runtime_roots": parsed_roots,
            "file_count": file_count,
            "aggregate_sha256": aggregate,
        }
    return parsed


def resolved_distribution_file(base: Path, relative: PurePosixPath, name: str) -> Path:
    candidate = base.joinpath(*relative.parts)
    if candidate.is_symlink():
        raise ValueError(f"installed file is a symlink for {name}: {relative}")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise ValueError(f"installed file is missing for {name}: {relative}") from error
    if resolved != base and base not in resolved.parents:
        raise ValueError(f"installed file escapes its distribution for {name}: {relative}")
    if not resolved.is_file():
        raise ValueError(f"installed path is not a file for {name}: {relative}")
    return resolved


def scan_runtime_paths(base: Path, roots: list[dict], name: str) -> set[str]:
    discovered = set()
    for root in roots:
        relative = root["path"]
        candidate = base.joinpath(*relative.parts)
        if candidate.is_symlink():
            raise ValueError(f"runtime root is a symlink for {name}: {relative}")
        try:
            resolved = candidate.resolve(strict=True)
        except OSError as error:
            raise ValueError(f"runtime root is missing for {name}: {relative}") from error
        if resolved != base and base not in resolved.parents:
            raise ValueError(f"runtime root escapes its distribution for {name}: {relative}")
        if root["kind"] == "file":
            if not resolved.is_file() or resolved.suffix not in RUNTIME_SUFFIXES:
                raise ValueError(f"runtime file root is invalid for {name}: {relative}")
            candidates = [resolved]
        else:
            if not resolved.is_dir():
                raise ValueError(f"runtime directory root is invalid for {name}: {relative}")
            candidates = []
            for path in resolved.rglob("*"):
                if path.is_symlink():
                    raise ValueError(f"runtime tree contains a symlink for {name}: {path}")
                if path.is_file() and path.suffix in RUNTIME_SUFFIXES:
                    candidates.append(path)
        for path in candidates:
            relative_path = path.relative_to(base).as_posix()
            safe_relative_path(relative_path, f"runtime file for {name}")
            if relative_path in discovered:
                raise ValueError(f"overlapping runtime roots for {name}: {relative_path}")
            discovered.add(relative_path)
    return discovered


def aggregate_runtime(runtime_files: dict[str, tuple[int, str]]) -> str:
    digest = hashlib.sha256()
    for path in sorted(runtime_files):
        size, file_digest = runtime_files[path]
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\0")
        digest.update(file_digest.encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def verify_distribution(name: str, expected_version: str, trusted: dict) -> None:
    try:
        distribution = importlib.metadata.distribution(name)
    except importlib.metadata.PackageNotFoundError as error:
        raise ValueError(f"missing distribution: {name}") from error
    if distribution.version != expected_version:
        raise ValueError(
            f"version mismatch for {name}: expected {expected_version}, got {distribution.version}"
        )
    metadata_name = distribution.metadata.get("Name") or name
    if normalized_name(metadata_name) != normalized_name(name):
        raise ValueError(f"distribution name mismatch for {name}")

    try:
        base = Path(distribution.locate_file("")).resolve(strict=True)
    except OSError as error:
        raise ValueError(f"distribution root is unavailable for {name}") from error
    if not base.is_dir():
        raise ValueError(f"distribution root is not a directory for {name}")

    files = list(distribution.files or ())
    if not files:
        raise ValueError(f"wheel RECORD is missing for {name}")
    runtime_files: dict[str, tuple[int, str]] = {}
    for entry in files:
        relative = safe_relative_path(entry.as_posix(), f"RECORD path for {name}")
        is_runtime = (
            not any(part.endswith(".dist-info") for part in relative.parts)
            and relative.suffix in RUNTIME_SUFFIXES
        )
        file_hash = entry.hash
        if file_hash is None:
            if is_runtime:
                raise ValueError(f"runtime RECORD entry has no hash for {name}: {relative}")
            continue
        installed = resolved_distribution_file(base, relative, name)
        if entry.size is not None and installed.stat().st_size != entry.size:
            raise ValueError(f"installed file size mismatch for {name}: {relative}")
        try:
            actual = encoded_digest(installed, file_hash.mode)
        except (OSError, ValueError) as error:
            raise ValueError(f"could not verify installed file for {name}: {relative}") from error
        if actual != file_hash.value:
            raise ValueError(f"installed file hash mismatch for {name}: {relative}")
        if is_runtime:
            if file_hash.mode != "sha256":
                raise ValueError(f"runtime RECORD hash is not sha256 for {name}: {relative}")
            relative_text = relative.as_posix()
            if relative_text in runtime_files:
                raise ValueError(f"duplicate runtime RECORD entry for {name}: {relative}")
            runtime_files[relative_text] = (installed.stat().st_size, sha256_digest(installed))
    if not runtime_files:
        raise ValueError(f"wheel RECORD has no hashed runtime files for {name}")

    discovered = scan_runtime_paths(base, trusted["runtime_roots"], name)
    recorded = set(runtime_files)
    if discovered != recorded:
        missing = sorted(discovered - recorded)
        unexpected = sorted(recorded - discovered)
        detail = []
        if missing:
            detail.append(f"unrecorded runtime files: {', '.join(missing[:5])}")
        if unexpected:
            detail.append(f"runtime files outside trusted roots: {', '.join(unexpected[:5])}")
        raise ValueError(f"runtime file set mismatch for {name}: {'; '.join(detail)}")

    if len(runtime_files) != trusted["file_count"]:
        raise ValueError(
            f"trusted runtime file count mismatch for {name}: "
            f"expected {trusted['file_count']}, got {len(runtime_files)}"
        )
    aggregate = aggregate_runtime(runtime_files)
    if aggregate != trusted["aggregate_sha256"]:
        raise ValueError(f"trusted runtime aggregate mismatch for {name}")

    expected_import = resolved_distribution_file(base, trusted["import_path"], name)
    spec = importlib.util.find_spec(trusted["import_name"])
    if spec is None or not spec.origin or spec.origin in {"built-in", "frozen"}:
        raise ValueError(f"import origin is unavailable for {name}")
    try:
        actual_import = Path(spec.origin).resolve(strict=True)
    except OSError as error:
        raise ValueError(f"import origin is missing for {name}") from error
    if actual_import != expected_import:
        raise ValueError(
            f"import origin mismatch for {name}: expected {expected_import}, got {actual_import}"
        )


def verify_runtime(requirements_path: Path, manifest_path: Path) -> None:
    pins = read_pins(requirements_path)
    trusted = load_manifest(manifest_path)
    expected_names = {normalized_name(name) for name, _version in pins}
    if set(trusted) != expected_names:
        raise ValueError("trusted runtime manifest distributions do not match requirements")
    for name, version in pins:
        key = normalized_name(name)
        entry = trusted[key]
        if entry["version"] != version:
            raise ValueError(f"trusted runtime version mismatch for {name}")
        verify_distribution(name, version, entry)


def main(argv: list[str]) -> int:
    if len(argv) not in {2, 3}:
        print("usage: verify_runtime.py requirements.txt [runtime_manifest.json]", file=sys.stderr)
        return 2
    manifest_path = Path(argv[2]) if len(argv) == 3 else Path(__file__).with_name("runtime_manifest.json")
    try:
        verify_runtime(Path(argv[1]), manifest_path)
    except (OSError, ValueError) as error:
        print(f"runtime verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
