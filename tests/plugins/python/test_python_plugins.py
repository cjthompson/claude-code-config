#!/usr/bin/env python3
"""Structural tests for the Python plugin family."""

from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PLUGINS = ROOT / "plugins"

EXPECTED_SKILLS = {
    "python-scripting": {
        "python-simple-scripts",
        "python-typing",
        "python-quality-tools",
        "macos-python-scripting",
    },
    "python-development": {
        "dignified-python",
        "python-testing",
        "python-project-tooling",
        "python-async-concurrency",
        "python-typing-reference",
        "tighten-python-types",
    },
}


class PythonPluginStructureTests(unittest.TestCase):
    def test_simple_script_skill_routes_shell_python_invocations(self) -> None:
        skill = (
            PLUGINS
            / "python-scripting/skills/python-simple-scripts/SKILL.md"
        ).read_text()
        frontmatter = skill.split("---", 2)[1]
        self.assertIn("Bash", frontmatter)
        self.assertIn("python3", frontmatter)
        self.assertIn("python -c", frontmatter)
        self.assertIn("heredoc", frontmatter)
        self.assertIn("one-off", frontmatter)

    def test_repository_deliverables_route_by_plugin(self) -> None:
        skill = (
            PLUGINS
            / "python-scripting/skills/python-simple-scripts/SKILL.md"
        ).read_text()
        normalized_skill = " ".join(skill.split())
        self.assertIn(
            "Use applicable skills from `python-development` when available",
            normalized_skill,
        )
        self.assertIn(
            "otherwise use applicable skills from `python-scripting`",
            normalized_skill,
        )
        self.assertIn(
            "repository's declared Python version and toolchain",
            normalized_skill,
        )

    def test_quality_tooling_routes_by_configuration_scope(self) -> None:
        scripting_skill = (
            PLUGINS
            / "python-scripting/skills/python-quality-tools/SKILL.md"
        ).read_text()
        development_skill = (
            PLUGINS
            / "python-development/skills/python-project-tooling/SKILL.md"
        ).read_text()

        self.assertIn("standalone Python files", scripting_skill)
        self.assertNotIn("Inspect `pyproject.toml`", scripting_skill)
        self.assertNotIn(
            "preserve the repository's exact configured commands",
            scripting_skill,
        )
        self.assertIn("existing repository toolchain", development_skill)
        self.assertIn("explicitly named files", development_skill)

    def test_simple_script_skill_has_a_bounded_wait_contract(self) -> None:
        skill = (
            PLUGINS
            / "python-scripting/skills/python-simple-scripts/SKILL.md"
        ).read_text()
        self.assertIn("## Bound waits and expose progress", skill)
        self.assertIn("potentially unbounded", skill)
        self.assertIn("asyncio.timeout", skill)
        self.assertIn("asyncio.wait_for", skill)
        self.assertIn("input()", skill)
        self.assertIn("flush=True", skill)
        self.assertIn("CancelledError", skill)
        self.assertIn("subprocess.TimeoutExpired", skill)
        self.assertIn("terminate", skill)
        self.assertIn("kill", skill)
        self.assertIn("reap", skill)

    def test_each_plugin_has_cross_host_manifests_and_exact_skill_inventory(self) -> None:
        for plugin_name, expected_skills in EXPECTED_SKILLS.items():
            plugin = PLUGINS / plugin_name
            with self.subTest(plugin=plugin_name):
                self.assertTrue((plugin / ".claude-plugin/plugin.json").is_file())
                self.assertTrue((plugin / ".cursor-plugin/plugin.json").is_file())
                self.assertTrue((plugin / ".codex-plugin/plugin.json").is_file())
                actual_skills = {
                    path.parent.name
                    for path in (plugin / "skills").glob("*/SKILL.md")
                }
                self.assertEqual(actual_skills, expected_skills)

    def test_only_scripting_plugin_owns_lsp_configuration(self) -> None:
        self.assertTrue((PLUGINS / "python-scripting/.lsp.json").is_file())
        self.assertFalse((PLUGINS / "python-development/.lsp.json").exists())

    def test_cross_plugin_handoffs_only_escalate_from_scripting_to_development(self) -> None:
        scripting_text = "\n".join(
            path.read_text()
            for path in (PLUGINS / "python-scripting/skills").glob("*/SKILL.md")
        )
        development_text = "\n".join(
            path.read_text()
            for path in (PLUGINS / "python-development/skills").glob("*/SKILL.md")
        )
        self.assertIn("python-development:", scripting_text)
        self.assertNotIn("python-scripting:", development_text)

    def test_codex_manifests_expose_all_skills(self) -> None:
        for plugin_name in EXPECTED_SKILLS:
            manifest_path = PLUGINS / plugin_name / ".codex-plugin/plugin.json"
            with self.subTest(plugin=plugin_name):
                manifest = json.loads(manifest_path.read_text())
                self.assertEqual(manifest["name"], plugin_name)
                self.assertEqual(manifest["skills"], "./skills/")
                self.assertIn("interface", manifest)

    def test_cross_host_manifest_metadata_is_consistent(self) -> None:
        for plugin_name in EXPECTED_SKILLS:
            plugin = PLUGINS / plugin_name
            claude = json.loads(
                (plugin / ".claude-plugin/plugin.json").read_text()
            )
            cursor = json.loads(
                (plugin / ".cursor-plugin/plugin.json").read_text()
            )
            codex = json.loads(
                (plugin / ".codex-plugin/plugin.json").read_text()
            )
            with self.subTest(plugin=plugin_name):
                self.assertEqual(claude["name"], plugin_name)
                self.assertTrue(claude["description"])
                self.assertEqual(cursor["name"], plugin_name)
                self.assertEqual(cursor["version"], "1.0.0")
                self.assertEqual(cursor["skills"], "./skills/")
                self.assertEqual(codex["name"], plugin_name)
                self.assertEqual(codex["version"], "1.0.0")
                self.assertEqual(codex["skills"], "./skills/")

    def test_codex_marketplace_registers_both_python_plugins(self) -> None:
        marketplace = json.loads(
            (ROOT / ".agents/plugins/marketplace.json").read_text()
        )
        entries = {entry["name"]: entry for entry in marketplace["plugins"]}
        for plugin_name in EXPECTED_SKILLS:
            with self.subTest(plugin=plugin_name):
                entry = entries[plugin_name]
                self.assertEqual(
                    entry["source"]["path"], f"./plugins/{plugin_name}"
                )
                self.assertEqual(entry["policy"]["installation"], "AVAILABLE")
                self.assertEqual(entry["policy"]["authentication"], "ON_INSTALL")

    def test_incidental_helper_evaluation_is_harness_backed_and_auditable(self) -> None:
        test_root = ROOT / "tests/plugins/python-scripting"
        harness = test_root / "harness"
        for module in (
            "generate_fixture.py",
            "oracle.py",
            "protocol.py",
            "trace_eval.py",
            "compliance.py",
            "prepare_run.py",
            "run_host.py",
            "evaluate_run.py",
        ):
            with self.subTest(module=module):
                self.assertTrue((harness / module).is_file())

        self.assertFalse((test_root / "fixtures/incidental-helper").exists())

        instructions = (test_root / "instructions.md").read_text()
        normalized_instructions = " ".join(instructions.split())
        rubric = (test_root / "test-incidental-helper.md").read_text()
        index = (test_root / "index.md").read_text()
        results = (test_root / "test-results.md").read_text()

        self.assertIn("Claude Sonnet 5", instructions)
        self.assertIn("gpt-5.6-terra", instructions)
        self.assertIn("temporary `CODEX_HOME`", instructions)
        self.assertIn("`--strict-config`", instructions)
        self.assertIn("`--skip-git-repo-check`", instructions)
        self.assertIn(
            "evaluate_run.py run --host codex --model gpt-5.6-terra",
            instructions,
        )
        self.assertIn("evaluate_run.py reevaluate --evidence", instructions)
        self.assertIn("--output-root <outside-repo>", instructions)
        self.assertIn("python-scripting-evidence-", instructions)
        self.assertIn("retained-bundle.json", instructions)
        self.assertIn("agent-workspace", instructions)
        self.assertIn("staged-marketplace/.agents/plugins/marketplace.json", instructions)
        self.assertIn(
            "credential-free marketplace smoke", normalized_instructions
        )
        self.assertIn("exit 0", instructions)
        self.assertIn("exit 70", instructions)
        self.assertIn("VALID", rubric)
        self.assertIn("INVALID", rubric)
        self.assertIn("Discovery", rubric)
        self.assertIn("Compliance", rubric)
        self.assertIn("semantic-review.json", instructions)
        self.assertIn("Compliance decision table", rubric)
        self.assertIn("exactly one Markdown table", rubric)
        self.assertIn("The generated fixture is valid", rubric)
        self.assertIn("malformed-input probe creates", rubric)
        self.assertIn("`source-unparseable`", rubric)
        self.assertIn("`workspace-leftover`", rubric)
        self.assertIn("retained evidence bundle", index)
        self.assertIn("evaluate_run.py run --host codex", index)
        self.assertIn("evaluate_run.py reevaluate --evidence", index)
        self.assertIn("Claude Sonnet 5", results)
        self.assertIn("gpt-5.6-terra", results)
        self.assertIn("credentials were absent", results)


if __name__ == "__main__":
    unittest.main()
