from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RELEASE_SCRIPT = ROOT / "scripts" / "release.py"
EXPECTED_VERSION = "0.9.2"
EXPECTED_MIN_EXTENSION_VERSION = "0.9.0"
EXPECTED_EXTENSION_FILES = {
    "LICENSE",
    "PRIVACY.md",
    "_locales/en/messages.json",
    "_locales/zh_CN/messages.json",
    "assets/icons/icon-16.png",
    "assets/icons/icon-32.png",
    "assets/icons/icon-48.png",
    "assets/icons/icon-128.png",
    "background.js",
    "extractors/browser_site_profiles.js",
    "manifest.json",
    "sidepanel.css",
    "sidepanel.html",
    "sidepanel_i18n.js",
    "sidepanel.js",
}
EXPECTED_LOCALE_MESSAGES = {
    "_locales/en/messages.json": {
        "extensionDescription": {
            "message": (
                "Turn web research into reviewable claims backed by exact quotes—"
                "stored in a local Markdown + SQLite vault."
            ),
        },
    },
    "_locales/zh_CN/messages.json": {
        "extensionDescription": {
            "message": "把网页研究资料转成由原文精确引文支撑、等待核验的 claim，并保存到本地 Markdown + SQLite 知识库。",
        },
    },
}
EXPECTED_COMPANION_FILES = {
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
}


def load_release_module():
    spec = importlib.util.spec_from_file_location("qc_release", RELEASE_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load release module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReleaseArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.release = load_release_module()

    def test_product_version_and_chrome_floor_are_consistent(self) -> None:
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
        plugin = json.loads((ROOT / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        package_lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))

        expected_icons = {
            "16": "assets/icons/icon-16.png",
            "32": "assets/icons/icon-32.png",
            "48": "assets/icons/icon-48.png",
            "128": "assets/icons/icon-128.png",
        }
        self.assertEqual(manifest["name"], "QC Smart Reader")
        self.assertEqual(manifest["version"], EXPECTED_VERSION)
        self.assertEqual(plugin["version"], EXPECTED_VERSION)
        self.assertEqual(package["version"], EXPECTED_VERSION)
        self.assertEqual(package_lock["version"], EXPECTED_VERSION)
        self.assertEqual(package_lock["packages"][""]["version"], EXPECTED_VERSION)
        self.assertEqual(manifest["minimum_chrome_version"], "116")
        self.assertEqual(manifest["icons"], expected_icons)
        self.assertEqual(manifest["action"]["default_icon"], expected_icons)
        installer = (ROOT / "install.command").read_text(encoding="utf-8")
        server = (ROOT / "companion_service" / "server.py").read_text(encoding="utf-8")
        self.assertIn(f'REQUIRED_SERVICE_VERSION="{EXPECTED_VERSION}"', installer)
        self.assertIn(f'MIN_EXTENSION_VERSION = "{EXPECTED_MIN_EXTENSION_VERSION}"', server)
        for relative in expected_icons.values():
            self.assertIn(relative, EXPECTED_EXTENSION_FILES)
            self.assertTrue((ROOT / relative).is_file(), relative)
        self.assertEqual(self.release.validate_version_contract(ROOT), EXPECTED_VERSION)

    def test_manifest_uses_minimum_permissions_for_supported_web_capture(self) -> None:
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))

        self.assertEqual(
            set(manifest["permissions"]),
            {"contextMenus", "downloads", "scripting", "sidePanel", "storage"},
        )
        self.assertEqual(
            manifest["host_permissions"],
            ["http://*/*", "https://*/*"],
        )

    def test_manifest_localization_contract_is_complete(self) -> None:
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))

        self.assertEqual(manifest["name"], "QC Smart Reader")
        self.assertEqual(manifest["default_locale"], "en")
        self.assertEqual(manifest["description"], "__MSG_extensionDescription__")

        loaded_messages = {
            relative: json.loads((ROOT / relative).read_text(encoding="utf-8"))
            for relative in EXPECTED_LOCALE_MESSAGES
        }
        self.assertEqual(loaded_messages, EXPECTED_LOCALE_MESSAGES)
        self.assertEqual(
            {frozenset(messages) for messages in loaded_messages.values()},
            {frozenset({"extensionDescription"})},
        )

    def test_release_allowlists_are_intentionally_narrow(self) -> None:
        self.assertEqual(set(self.release.EXTENSION_FILES), EXPECTED_EXTENSION_FILES)
        self.assertEqual(set(self.release.COMPANION_FILES), EXPECTED_COMPANION_FILES)

        requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
        lock = (ROOT / "requirements.lock").read_text(encoding="utf-8")
        installer = (ROOT / "install.command").read_text(encoding="utf-8")
        launcher = (ROOT / "start.command").read_text(encoding="utf-8")
        self.assertIn("pypdf==6.16.0", requirements)
        self.assertIn("typing_extensions==4.15.0", requirements)
        self.assertIn("8c47581faa1cba7006ac269da30075c929c251cc4ffbafb2bcbe260306631118", lock)
        self.assertIn("f0fa19c6845758ab08074a0cfa8b7aecb71c999ca73d62883bc25cc018c4e548", lock)
        self.assertEqual(
            self.release.read_locked_requirements(ROOT / "requirements.lock"),
            self.release.EXPECTED_LOCKED_REQUIREMENTS,
        )
        runtime_manifest = json.loads(
            (ROOT / "companion_service" / "runtime_manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(runtime_manifest, self.release.EXPECTED_RUNTIME_MANIFEST)
        self.assertIn("--require-hashes", launcher)
        self.assertIn("--only-binary=:all:", launcher)
        self.assertIn("requirements.lock", installer)

    def test_build_is_deterministic_and_archives_have_exact_rooted_contents(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qc-release-test-") as temp_dir:
            temp = Path(temp_dir)
            source = self.make_clean_source(temp / "source")
            first = self.release.build_release(source, temp / "first")
            second = self.release.build_release(source, temp / "second")

            self.assertEqual(first.version, EXPECTED_VERSION)
            self.assertEqual(first.sha256, second.sha256)
            self.assertEqual(
                (temp / "first" / "SHA256SUMS").read_bytes(),
                (temp / "second" / "SHA256SUMS").read_bytes(),
            )

            extension_name = f"qc-smart-reader-extension-{EXPECTED_VERSION}.zip"
            companion_name = f"qc-smart-reader-companion-{EXPECTED_VERSION}.zip"
            self.assertEqual(set(first.sha256), {extension_name, companion_name})

            for artifact_name, expected_files in (
                (extension_name, EXPECTED_EXTENSION_FILES),
                (companion_name, EXPECTED_COMPANION_FILES),
            ):
                first_path = temp / "first" / artifact_name
                second_path = temp / "second" / artifact_name
                self.assertEqual(first_path.read_bytes(), second_path.read_bytes())
                self.assertEqual(first.sha256[artifact_name], self.file_sha256(first_path))
                with zipfile.ZipFile(first_path) as archive:
                    self.assertEqual(set(archive.namelist()), expected_files)
                    self.assertTrue(all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in archive.infolist()))
                    if artifact_name == companion_name:
                        executable = {
                            info.filename
                            for info in archive.infolist()
                            if (info.external_attr >> 16) & 0o111
                        }
                        self.assertEqual(
                            executable,
                            {"install.command", "scripts/smoke_e2e.py", "start.command", "uninstall.command"},
                        )

            with zipfile.ZipFile(temp / "first" / extension_name) as extension:
                self.assertIn("manifest.json", extension.namelist())
                self.assertFalse(any(name.startswith("qc-smart-reader-extension/") for name in extension.namelist()))
                packaged_manifest = json.loads(extension.read("manifest.json"))
                self.assertEqual(packaged_manifest["default_locale"], "en")
                self.assertEqual(packaged_manifest["description"], "__MSG_extensionDescription__")
                self.assertEqual(
                    {
                        relative: json.loads(extension.read(relative))
                        for relative in EXPECTED_LOCALE_MESSAGES
                    },
                    EXPECTED_LOCALE_MESSAGES,
                )
                referenced_icons = set(packaged_manifest["icons"].values()) | set(
                    packaged_manifest["action"]["default_icon"].values()
                )
                self.assertEqual(
                    referenced_icons,
                    {
                        "assets/icons/icon-16.png",
                        "assets/icons/icon-32.png",
                        "assets/icons/icon-48.png",
                        "assets/icons/icon-128.png",
                    },
                )
                self.assertTrue(referenced_icons.issubset(extension.namelist()))

            checksum_lines = (temp / "first" / "SHA256SUMS").read_text(encoding="ascii").splitlines()
            self.assertEqual(
                checksum_lines,
                [f"{first.sha256[name]}  {name}" for name in sorted(first.sha256)],
            )

    def test_release_rejects_modified_required_source(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qc-release-dirty-") as temp_dir:
            temp = Path(temp_dir)
            source = self.make_clean_source(temp / "source")
            path = source / "background.js"
            path.write_text(path.read_text(encoding="utf-8") + "\n// dirty\n", encoding="utf-8")

            with self.assertRaisesRegex(self.release.ReleaseError, "background\\.js"):
                self.release.build_release(source, temp / "dist")

    def test_release_rejects_untracked_required_source(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qc-release-untracked-") as temp_dir:
            temp = Path(temp_dir)
            source = self.make_clean_source(temp / "source")
            subprocess.run(
                ["git", "rm", "--cached", "companion_service/pdf_ocr_worker.swift"],
                cwd=source,
                check=True,
                capture_output=True,
                text=True,
            )

            with self.assertRaisesRegex(self.release.ReleaseError, "pdf_ocr_worker\\.swift"):
                self.release.build_release(source, temp / "dist")

    def test_release_rejects_missing_allowlisted_source(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qc-release-missing-") as temp_dir:
            temp = Path(temp_dir)
            source = self.make_clean_source(temp / "source")
            (source / "sidepanel.css").unlink()

            with self.assertRaisesRegex(self.release.ReleaseError, "sidepanel\\.css"):
                self.release.build_release(source, temp / "dist", require_clean=False)

    def test_release_rejects_service_and_extension_version_drift(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qc-release-version-drift-") as temp_dir:
            temp = Path(temp_dir)
            source = self.make_clean_source(temp / "source")
            server_path = source / "companion_service" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8").replace(
                    'SERVICE_VERSION = "0.9.2"',
                    'SERVICE_VERSION = "0.9.3"',
                    1,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(self.release.ReleaseError, "version mismatch"):
                self.release.validate_release(source, require_clean=False)

    def test_release_rejects_minimum_extension_newer_than_release(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qc-release-min-extension-drift-") as temp_dir:
            source = self.make_clean_source(Path(temp_dir) / "source")
            server_path = source / "companion_service" / "server.py"
            server_path.write_text(
                server_path.read_text(encoding="utf-8").replace(
                    'MIN_EXTENSION_VERSION = "0.9.0"',
                    'MIN_EXTENSION_VERSION = "0.9.3"',
                    1,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(self.release.ReleaseError, "minimum extension version"):
                self.release.validate_release(source, require_clean=False)

    def test_release_rejects_installer_contract_drift(self) -> None:
        for original, replacement, message in (
            ('REQUIRED_SERVICE_VERSION="0.9.2"', 'REQUIRED_SERVICE_VERSION="0.9.3"', "installer service version"),
            ('REQUIRED_API_VERSION="1"', 'REQUIRED_API_VERSION="2"', "installer API version"),
        ):
            with self.subTest(replacement=replacement), tempfile.TemporaryDirectory(
                prefix="qc-release-installer-drift-"
            ) as temp_dir:
                source = self.make_clean_source(Path(temp_dir) / "source")
                installer = source / "install.command"
                installer.write_text(
                    installer.read_text(encoding="utf-8").replace(original, replacement, 1),
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(self.release.ReleaseError, message):
                    self.release.validate_release(source, require_clean=False)

    def test_release_rejects_package_metadata_version_drift(self) -> None:
        for relative, old, new in (
            ("package.json", '"version": "0.9.2"', '"version": "0.9.3"'),
            ("package-lock.json", '"version": "0.9.2"', '"version": "0.9.3"'),
        ):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory(
                prefix="qc-release-package-version-drift-"
            ) as temp_dir:
                source = self.make_clean_source(Path(temp_dir) / "source")
                metadata = source / relative
                metadata.write_text(
                    metadata.read_text(encoding="utf-8").replace(old, new, 1),
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(self.release.ReleaseError, "version mismatch"):
                    self.release.validate_release(source, require_clean=False)

    def test_release_rejects_fake_active_hash_with_real_hash_only_in_comment(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qc-release-lock-drift-") as temp_dir:
            source = self.make_clean_source(Path(temp_dir) / "source")
            lock_path = source / "requirements.lock"
            expected = "8c47581faa1cba7006ac269da30075c929c251cc4ffbafb2bcbe260306631118"
            fake = "0" * 64
            lock_path.write_text(
                lock_path.read_text(encoding="utf-8").replace(
                    f"--hash=sha256:{expected}",
                    f"--hash=sha256:{fake}\n# decoy sha256:{expected}",
                    1,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(self.release.ReleaseError, "audited release wheel hashes"):
                self.release.validate_release(source, require_clean=False)

    def test_release_rejects_runtime_manifest_aggregate_drift(self) -> None:
        with tempfile.TemporaryDirectory(prefix="qc-release-runtime-manifest-drift-") as temp_dir:
            source = self.make_clean_source(Path(temp_dir) / "source")
            manifest_path = source / "companion_service" / "runtime_manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["distributions"]["pypdf"]["aggregate_sha256"] = "0" * 64
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(self.release.ReleaseError, "runtime manifest"):
                self.release.validate_release(source, require_clean=False)

    def make_clean_source(self, destination: Path) -> Path:
        required = (
            set(self.release.EXTENSION_FILES)
            | set(self.release.COMPANION_FILES)
            | set(self.release.VERSION_CONTRACT_FILES)
        )
        for relative in sorted(required):
            source = ROOT / relative
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)

        subprocess.run(["git", "init", "-q"], cwd=destination, check=True)
        subprocess.run(["git", "config", "user.name", "QC Release Tests"], cwd=destination, check=True)
        subprocess.run(["git", "config", "user.email", "release-tests@example.invalid"], cwd=destination, check=True)
        subprocess.run(["git", "add", "."], cwd=destination, check=True)
        subprocess.run(["git", "commit", "-qm", "fixture"], cwd=destination, check=True)
        return destination

    @staticmethod
    def file_sha256(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()


if __name__ == "__main__":
    unittest.main()
