#!/usr/bin/env python3
"""Build deterministic QC Smart Reader release archives from committed sources."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Dict, Iterable, NamedTuple, Sequence


EXTENSION_FILES = (
    "LICENSE",
    "PRIVACY.md",
    "assets/icons/icon-16.png",
    "assets/icons/icon-32.png",
    "assets/icons/icon-48.png",
    "assets/icons/icon-128.png",
    "background.js",
    "extractors/browser_site_profiles.js",
    "manifest.json",
    "sidepanel.css",
    "sidepanel.html",
    "sidepanel.js",
)

COMPANION_FILES = (
    "LICENSE",
    "PRIVACY.md",
    "companion_service/README.md",
    "companion_service/pdf_extract_worker.py",
    "companion_service/pdf_ocr_worker.swift",
    "companion_service/server.py",
    "companion_service/runtime_manifest.json",
    "companion_service/verify_runtime.py",
    "install.command",
    "requirements.lock",
    "requirements.txt",
    "scripts/smoke_e2e.py",
    "start.command",
    "uninstall.command",
    "上手指南.md",
)

VERSION_CONTRACT_FILES = (
    "manifest.json",
    ".codex-plugin/plugin.json",
    "package.json",
    "package-lock.json",
    "companion_service/server.py",
)

EXECUTABLE_FILES = {
    "install.command",
    "scripts/smoke_e2e.py",
    "start.command",
    "uninstall.command",
}

ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
CHROME_VERSION_RE = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,3}$")
PIN_RE = re.compile(r"([A-Za-z0-9][A-Za-z0-9_.-]*)==([A-Za-z0-9][A-Za-z0-9_.+!-]*)")
HASH_RE = re.compile(r"--hash=sha256:([0-9a-f]{64})")
EXPECTED_LOCKED_REQUIREMENTS = {
    "pypdf": (
        "6.16.0",
        frozenset({"8c47581faa1cba7006ac269da30075c929c251cc4ffbafb2bcbe260306631118"}),
    ),
    "typing-extensions": (
        "4.15.0",
        frozenset({"f0fa19c6845758ab08074a0cfa8b7aecb71c999ca73d62883bc25cc018c4e548"}),
    ),
}
EXPECTED_RUNTIME_MANIFEST = {
    "schema_version": 1,
    "canonical_line": r"path\0size\0sha256\n",
    "distributions": {
        "pypdf": {
            "version": "6.16.0",
            "import_name": "pypdf",
            "import_path": "pypdf/__init__.py",
            "runtime_roots": [{"path": "pypdf", "kind": "directory"}],
            "file_count": 57,
            "aggregate_sha256": "c494c03423bc7b166096e2f4a84ce66d3da5491330111fd63be8a82a2a52e19f",
        },
        "typing-extensions": {
            "version": "4.15.0",
            "import_name": "typing_extensions",
            "import_path": "typing_extensions.py",
            "runtime_roots": [{"path": "typing_extensions.py", "kind": "file"}],
            "file_count": 1,
            "aggregate_sha256": "282f9e65668b28b7b3511e22556ef0a5815847042db7c6d96f8b31f4915cd98d",
        },
    },
}


class ReleaseError(RuntimeError):
    """Raised when release inputs violate the release contract."""


class ReleaseResult(NamedTuple):
    version: str
    artifacts: Dict[str, Path]
    sha256: Dict[str, str]


def _read_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ReleaseError(f"could not read release metadata {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ReleaseError(f"invalid JSON in release metadata {path}: {error}") from error
    if not isinstance(payload, dict):
        raise ReleaseError(f"release metadata must be a JSON object: {path}")
    return payload


def _validate_chrome_version(value: object, field: str) -> str:
    version = str(value or "").strip()
    if not CHROME_VERSION_RE.fullmatch(version):
        raise ReleaseError(f"{field} must be a Chrome-compatible 1-4 part version")
    parts = [int(part) for part in version.split(".")]
    if any(part > 65535 for part in parts):
        raise ReleaseError(f"{field} components must be between 0 and 65535")
    return version


def _chrome_version_parts(value: str) -> tuple[int, ...]:
    parts = tuple(int(part) for part in value.split("."))
    return parts + (0,) * (4 - len(parts))


def _read_python_constants(path: Path, required: Sequence[str]) -> dict[str, object]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError) as error:
        raise ReleaseError(f"could not parse release contract {path}: {error}") from error
    values: dict[str, object] = {}
    for statement in tree.body:
        if not isinstance(statement, ast.Assign) or len(statement.targets) != 1:
            continue
        target = statement.targets[0]
        if not isinstance(target, ast.Name) or target.id not in required:
            continue
        if isinstance(statement.value, ast.Constant):
            values[target.id] = statement.value.value
    missing = [name for name in required if name not in values]
    if missing:
        raise ReleaseError(f"missing service release constant(s): {', '.join(missing)}")
    return values


def _read_shell_constants(path: Path, required: Sequence[str]) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ReleaseError(f"could not read release contract {path}: {error}") from error
    wanted = set(required)
    values: dict[str, str] = {}
    pattern = re.compile(r'^([A-Z][A-Z0-9_]*)=(?:"([^"\n]*)"|([0-9]+))\s*$')
    for line in lines:
        match = pattern.fullmatch(line.strip())
        if not match or match.group(1) not in wanted:
            continue
        name = match.group(1)
        if name in values:
            raise ReleaseError(f"duplicate installer release constant: {name}")
        values[name] = match.group(2) if match.group(2) is not None else match.group(3)
    missing = [name for name in required if name not in values]
    if missing:
        raise ReleaseError(f"missing installer release constant(s): {', '.join(missing)}")
    return values


def _normalized_package_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _read_requirement_pins(path: Path) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ReleaseError(f"could not read requirements {path}: {error}") from error
    pins: dict[str, str] = {}
    for raw in lines:
        value = raw.strip()
        if not value or value.startswith("#"):
            continue
        match = PIN_RE.fullmatch(value)
        if not match:
            raise ReleaseError(f"requirements must contain exact pins only: {value}")
        name, version = match.groups()
        key = _normalized_package_name(name)
        if key in pins:
            raise ReleaseError(f"duplicate requirement pin: {name}")
        pins[key] = version
    if not pins:
        raise ReleaseError("requirements.txt must not be empty")
    return pins


def _logical_lock_lines(path: Path) -> list[str]:
    try:
        physical = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ReleaseError(f"could not read dependency lock {path}: {error}") from error
    logical: list[str] = []
    pending = ""
    for raw in physical:
        value = raw.strip()
        if not value or value.startswith("#"):
            continue
        continued = value.endswith("\\")
        if continued:
            value = value[:-1].rstrip()
        pending = f"{pending} {value}".strip()
        if not continued:
            logical.append(pending)
            pending = ""
    if pending:
        raise ReleaseError("requirements.lock has an unfinished continuation")
    return logical


def read_locked_requirements(path: Path) -> dict[str, tuple[str, frozenset[str]]]:
    locked: dict[str, tuple[str, frozenset[str]]] = {}
    for logical in _logical_lock_lines(path):
        try:
            tokens = shlex.split(logical, comments=True, posix=True)
        except ValueError as error:
            raise ReleaseError(f"invalid requirements.lock entry: {logical}") from error
        if len(tokens) < 2:
            raise ReleaseError(f"locked requirement is missing a wheel hash: {logical}")
        pin = PIN_RE.fullmatch(tokens[0])
        if not pin:
            raise ReleaseError(f"requirements.lock must contain exact pins only: {tokens[0]}")
        name, version = pin.groups()
        hashes: set[str] = set()
        for token in tokens[1:]:
            hash_match = HASH_RE.fullmatch(token)
            if not hash_match:
                raise ReleaseError(f"unsupported requirements.lock option: {token}")
            hashes.add(hash_match.group(1))
        key = _normalized_package_name(name)
        if key in locked:
            raise ReleaseError(f"duplicate locked requirement: {name}")
        locked[key] = (version, frozenset(hashes))
    if not locked:
        raise ReleaseError("requirements.lock must not be empty")
    return locked


def validate_dependency_lock(source_dir: Path) -> None:
    pins = _read_requirement_pins(source_dir / "requirements.txt")
    locked = read_locked_requirements(source_dir / "requirements.lock")
    if {name: version for name, (version, _hashes) in locked.items()} != pins:
        raise ReleaseError("requirements.txt and requirements.lock pins do not match")
    if locked != EXPECTED_LOCKED_REQUIREMENTS:
        raise ReleaseError("requirements.lock does not contain the audited release wheel hashes")
    manifest = _read_json(source_dir / "companion_service" / "runtime_manifest.json")
    if manifest != EXPECTED_RUNTIME_MANIFEST:
        raise ReleaseError("runtime manifest does not contain the audited installed-file aggregates")


def validate_version_contract(source_dir: Path) -> str:
    manifest = _read_json(source_dir / "manifest.json")
    plugin = _read_json(source_dir / ".codex-plugin" / "plugin.json")
    package = _read_json(source_dir / "package.json")
    package_lock = _read_json(source_dir / "package-lock.json")
    extension_version = _validate_chrome_version(manifest.get("version"), "manifest.json version")
    plugin_version = _validate_chrome_version(plugin.get("version"), ".codex-plugin/plugin.json version")
    package_version = _validate_chrome_version(package.get("version"), "package.json version")
    package_lock_version = _validate_chrome_version(package_lock.get("version"), "package-lock.json version")
    package_lock_root = package_lock.get("packages", {}).get("", {})
    package_lock_root_version = _validate_chrome_version(
        package_lock_root.get("version"),
        "package-lock.json root package version",
    )
    declared_versions = {
        "manifest.json": extension_version,
        ".codex-plugin/plugin.json": plugin_version,
        "package.json": package_version,
        "package-lock.json": package_lock_version,
        "package-lock.json root package": package_lock_root_version,
    }
    if any(version != extension_version for version in declared_versions.values()):
        raise ReleaseError(
            "release version mismatch: "
            + ", ".join(f"{name}={version}" for name, version in declared_versions.items())
        )
    minimum_chrome = str(manifest.get("minimum_chrome_version") or "").strip()
    if minimum_chrome != "116":
        raise ReleaseError("manifest.json minimum_chrome_version must be 116")
    service = _read_python_constants(
        source_dir / "companion_service" / "server.py",
        ("SERVICE_VERSION", "API_VERSION", "SCHEMA_VERSION", "MIN_EXTENSION_VERSION"),
    )
    service_version = _validate_chrome_version(service["SERVICE_VERSION"], "SERVICE_VERSION")
    minimum_extension = _validate_chrome_version(
        service["MIN_EXTENSION_VERSION"],
        "MIN_EXTENSION_VERSION",
    )
    if service_version != extension_version:
        raise ReleaseError(
            "release version mismatch: "
            f"extension={extension_version}, service={service_version}"
        )
    if _chrome_version_parts(minimum_extension) > _chrome_version_parts(extension_version):
        raise ReleaseError(
            "minimum extension version cannot be newer than the release: "
            f"minimum extension={minimum_extension}, extension={extension_version}"
        )
    if service["API_VERSION"] != 1 or service["SCHEMA_VERSION"] != 1:
        raise ReleaseError(
            f"release {extension_version} requires companion API_VERSION=1 and SCHEMA_VERSION=1"
        )
    installer = _read_shell_constants(
        source_dir / "install.command",
        ("REQUIRED_SERVICE_VERSION", "REQUIRED_API_VERSION"),
    )
    if installer["REQUIRED_SERVICE_VERSION"] != service_version:
        raise ReleaseError(
            "installer service version mismatch: "
            f"install.command={installer['REQUIRED_SERVICE_VERSION']}, service={service_version}"
        )
    if installer["REQUIRED_API_VERSION"] != str(service["API_VERSION"]):
        raise ReleaseError(
            "installer API version mismatch: "
            f"install.command={installer['REQUIRED_API_VERSION']}, service={service['API_VERSION']}"
        )
    return extension_version


def _release_inputs() -> tuple[str, ...]:
    return tuple(sorted(set(EXTENSION_FILES) | set(COMPANION_FILES) | set(VERSION_CONTRACT_FILES)))


def _validate_relative_path(relative: str) -> None:
    path = PurePosixPath(relative)
    if path.is_absolute() or not path.parts or ".." in path.parts or str(path) != relative:
        raise ReleaseError(f"release allowlist contains an unsafe path: {relative!r}")


def validate_release_sources(source_dir: Path) -> None:
    source_root = source_dir.resolve()
    missing = []
    unsafe = []
    for relative in _release_inputs():
        _validate_relative_path(relative)
        path = source_root / relative
        if not path.is_file():
            missing.append(relative)
            continue
        if path.is_symlink() or source_root not in path.resolve().parents:
            unsafe.append(relative)
    if missing:
        raise ReleaseError("missing allowlisted release source(s): " + ", ".join(missing))
    if unsafe:
        raise ReleaseError("release sources must be regular in-tree files: " + ", ".join(unsafe))


def validate_required_sources_clean(source_dir: Path) -> None:
    command = [
        "git",
        "-C",
        str(source_dir),
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        *_release_inputs(),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as error:
        raise ReleaseError(f"git is required to verify release inputs: {error}") from error
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "not a Git working tree").strip()
        raise ReleaseError(f"could not verify committed release inputs: {detail}")
    dirty = [line for line in completed.stdout.splitlines() if line.strip()]
    if dirty:
        raise ReleaseError(
            "release inputs must be committed and clean; dirty or untracked required source(s): "
            + "; ".join(dirty)
        )


def validate_release(source_dir: Path, require_clean: bool = True) -> str:
    source_root = source_dir.expanduser().resolve()
    validate_release_sources(source_root)
    version = validate_version_contract(source_root)
    validate_dependency_lock(source_root)
    if require_clean:
        validate_required_sources_clean(source_root)
    return version


def _zip_info(relative: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(relative, date_time=ZIP_TIMESTAMP)
    # Store bytes verbatim so archive hashes do not depend on the host zlib
    # version. The two runtime allowlists are small enough that compression is
    # not worth weakening cross-machine reproducibility.
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    mode = 0o755 if relative in EXECUTABLE_FILES else 0o644
    info.external_attr = (stat.S_IFREG | mode) << 16
    info.extra = b""
    info.comment = b""
    return info


def _write_archive(source_dir: Path, output_path: Path, files: Sequence[str]) -> None:
    temporary = output_path.with_name(f".{output_path.name}.tmp")
    try:
        with zipfile.ZipFile(
            temporary,
            mode="w",
            compression=zipfile.ZIP_STORED,
        ) as archive:
            archive.comment = b""
            for relative in sorted(files):
                archive.writestr(
                    _zip_info(relative),
                    (source_dir / relative).read_bytes(),
                    compress_type=zipfile.ZIP_STORED,
                )
        os.replace(temporary, output_path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_write(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def build_release(source_dir: Path, output_dir: Path, require_clean: bool = True) -> ReleaseResult:
    source_root = source_dir.expanduser().resolve()
    version = validate_release(source_root, require_clean=require_clean)
    destination = output_dir.expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)

    artifact_files = {
        f"qc-smart-reader-extension-{version}.zip": EXTENSION_FILES,
        f"qc-smart-reader-companion-{version}.zip": COMPANION_FILES,
    }
    artifacts = {}
    checksums = {}
    for name in sorted(artifact_files):
        path = destination / name
        _write_archive(source_root, path, artifact_files[name])
        artifacts[name] = path
        checksums[name] = _file_sha256(path)

    checksum_text = "".join(f"{checksums[name]}  {name}\n" for name in sorted(checksums))
    _atomic_write(destination / "SHA256SUMS", checksum_text.encode("ascii"))
    return ReleaseResult(version=version, artifacts=artifacts, sha256=checksums)


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Build deterministic QC Smart Reader release archives.")
    parser.add_argument("--source-dir", type=Path, default=project_root)
    parser.add_argument("--output-dir", type=Path, default=project_root / "dist" / "release")
    parser.add_argument("--check", action="store_true", help="validate release inputs without writing archives")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.check:
            version = validate_release(args.source_dir)
            print(f"release inputs are valid for QC Smart Reader {version}")
            return 0
        result = build_release(args.source_dir, args.output_dir)
    except ReleaseError as error:
        print(f"release blocked: {error}", file=sys.stderr)
        return 1

    print(f"QC Smart Reader {result.version} release artifacts:")
    for name in sorted(result.artifacts):
        print(f"  {result.sha256[name]}  {result.artifacts[name]}")
    print(f"  checksums: {args.output_dir.expanduser().resolve() / 'SHA256SUMS'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
