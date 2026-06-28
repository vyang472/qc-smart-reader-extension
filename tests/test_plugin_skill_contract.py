from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PluginSkillContractCase(unittest.TestCase):
    def test_plugin_manifest_exposes_qc_smart_reader_skill_bundle(self) -> None:
        manifest_path = ROOT / ".codex-plugin" / "plugin.json"
        self.assertTrue(manifest_path.exists())
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertEqual(manifest["name"], ROOT.name)
        self.assertEqual(manifest["skills"], "./skills/")
        self.assertEqual(manifest["interface"]["displayName"], "QC Smart Reader")
        self.assertIn("companion service", manifest["description"])
        self.assertIn("Citation-backed", " ".join(manifest["interface"]["capabilities"]))
        self.assertNotIn("[TODO", manifest_path.read_text(encoding="utf-8"))

    def test_qc_smart_reader_skill_has_operator_workflow_and_contract_reference(self) -> None:
        skill_dir = ROOT / "skills" / "qc-smart-reader"
        skill_path = skill_dir / "SKILL.md"
        reference_path = skill_dir / "references" / "project-contract.md"
        self.assertTrue(skill_path.exists())
        self.assertTrue(reference_path.exists())

        skill = skill_path.read_text(encoding="utf-8")
        reference = reference_path.read_text(encoding="utf-8")
        self.assertIn("name: qc-smart-reader", skill)
        self.assertIn("Chrome extension", skill)
        self.assertIn("companion service", skill)
        self.assertIn("references/project-contract.md", skill)
        self.assertIn("python3 companion_service/server.py", skill)
        self.assertIn("python3 -m unittest discover -s tests -v", skill)
        self.assertNotIn("[TODO", skill)

        for expected in [
            "GET /health",
            "POST /v1/captures",
            "AGENTS.md",
            "pagination_needed",
            "attachment_missing",
            "source_id",
            "chunk_id",
            "strategy task briefs",
        ]:
            self.assertIn(expected, reference)

    def test_skill_agent_metadata_matches_skill_purpose(self) -> None:
        metadata_path = ROOT / "skills" / "qc-smart-reader" / "agents" / "openai.yaml"
        self.assertTrue(metadata_path.exists())
        metadata = metadata_path.read_text(encoding="utf-8")
        self.assertIn('display_name: "QC Smart Reader"', metadata)
        self.assertIn("Run and audit QC Smart Reader research projects.", metadata)
        self.assertNotIn("[TODO", metadata)


if __name__ == "__main__":
    unittest.main()
