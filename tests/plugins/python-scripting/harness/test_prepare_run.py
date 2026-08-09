"""Isolation-layout and policy tests for the incidental-helper harness."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
import unittest

from prepare_run import prepare_run


REPO_ROOT = Path(__file__).resolve().parents[4]


class PrepareRunTests(unittest.TestCase):
    """Catch exposed evaluator data, non-isolated roots, and weak policies."""

    def test_prepares_three_distinct_unpredictable_roots_with_hidden_evidence(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)

            roots = {
                layout.agent_workspace,
                layout.staged_marketplace,
                layout.evaluator_workspace,
            }
            self.assertEqual(len(roots), 3)
            self.assertTrue(all(path.parent == Path(output).resolve() for path in roots))
            self.assertTrue(all(path.name.startswith("python-scripting-eval-") for path in roots))
            self.assertTrue(all(len(path.name) > len("python-scripting-eval-") + 4 for path in roots))

            agent_files = {
                path.relative_to(layout.agent_workspace).as_posix()
                for path in layout.agent_workspace.rglob("*")
                if path.is_file()
            }
            self.assertEqual(
                agent_files,
                {"owners.json"}
                | {f"artifacts/run-{number:03d}.json" for number in range(1, 33)},
            )
            self.assertFalse(any(path.is_symlink() for path in layout.staged_marketplace.rglob("*")))

            marketplace = json.loads(layout.marketplace_manifest.read_text(encoding="utf-8"))
            self.assertEqual(
                layout.marketplace_manifest,
                layout.staged_marketplace / ".agents" / "plugins" / "marketplace.json",
            )
            self.assertEqual(marketplace["name"], "python-scripting-test")
            self.assertEqual(
                [(item["name"], item["source"]) for item in marketplace["plugins"]],
                [
                    (
                        "python-scripting",
                        {"source": "local", "path": "./plugins/python-scripting"},
                    )
                ],
            )
            staged_plugins = {
                path.name
                for path in (layout.staged_marketplace / "plugins").iterdir()
                if path.is_dir()
            }
            self.assertEqual(staged_plugins, {"python-scripting"})

            self.assertTrue(layout.oracle_path.is_relative_to(layout.evaluator_workspace))
            self.assertTrue(layout.fixture_manifest_path.is_relative_to(layout.evaluator_workspace))
            self.assertTrue(layout.baseline_hashes_path.is_relative_to(layout.evaluator_workspace))
            self.assertFalse(layout.oracle_path.is_relative_to(layout.agent_workspace))
            self.assertEqual(
                json.loads(layout.baseline_hashes_path.read_text(encoding="utf-8")),
                layout.pre_run_hashes,
            )
            self.assertEqual(
                hashlib.sha256(layout.baseline_hashes_path.read_bytes()).hexdigest(),
                layout.baseline_hashes_sha256,
            )
            self.assertEqual(
                set(layout.pre_run_hashes),
                agent_files,
            )

    def test_default_output_root_is_supported_and_remains_outside_repository(self) -> None:
        layout = prepare_run(REPO_ROOT, None)
        self.addCleanup(layout.cleanup)

        for root in (
            layout.agent_workspace,
            layout.staged_marketplace,
            layout.evaluator_workspace,
        ):
            self.assertFalse(root.is_relative_to(REPO_ROOT))

    def test_rejects_repository_output_before_creating_it(self) -> None:
        destination = REPO_ROOT / ".task-5-must-not-be-created"
        self.assertFalse(destination.exists())

        with self.assertRaisesRegex(ValueError, "outside the repository"):
            prepare_run(REPO_ROOT, destination)

        self.assertFalse(destination.exists())

    def test_rejects_symlinked_plugin_source_root_before_copy(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            repository = root / "repository"
            (repository / "plugins").mkdir(parents=True)
            plugin_target = root / "plugin-target"
            plugin_target.mkdir()
            (repository / "plugins" / "python-scripting").symlink_to(
                plugin_target,
                target_is_directory=True,
            )

            with self.assertRaisesRegex(ValueError, "source root.*symlink"):
                prepare_run(repository, root / "output")

    def test_codex_policy_is_minimal_secret_free_and_uses_absolute_denies(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            policy = layout.codex_config_path.read_text(encoding="utf-8")

            self.assertIn('default_permissions = "python-scripting-test"', policy)
            self.assertIn('\":minimal\" = \"read\"', policy)
            self.assertIn('[permissions.python-scripting-test.filesystem.\":workspace_roots\"]', policy)
            self.assertIn('\".\" = \"write\"', policy)
            for denied in (
                layout.repo_root,
                layout.evaluator_workspace,
                layout.staged_marketplace,
                layout.codex_home,
            ):
                self.assertTrue(denied.is_absolute())
                self.assertIn(f'\"{denied}\" = \"deny\"', policy)
            self.assertIn("enabled = false", policy)
            self.assertIn('inherit = "none"', policy)
            self.assertIn("ignore_default_excludes = false", policy)
            self.assertEqual(policy.count(' = "include"'), 4)
            for variable in ("PATH", "HOME", "LANG", "PYTHONNOUSERSITE"):
                self.assertIn(f'\"{variable}\" = \"include\"', policy)
            for secret in ("OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "CODEX_ACCESS_TOKEN"):
                self.assertNotIn(secret, policy)
            self.assertNotIn("sandbox", policy.lower())
            self.assertNotIn("add-dir", policy.lower())
            self.assertFalse(
                layout.codex_executable.is_relative_to(Path.home() / ".codex")
            )

    def test_claude_profile_allows_only_required_roots_and_denies_sensitive_paths(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            profile = layout.claude_sandbox_profile.read_text(encoding="utf-8")

            self.assertIn("(deny default)", profile)
            self.assertIn(f'(subpath "{layout.agent_workspace}")', profile)
            self.assertIn(f'(subpath "{layout.staged_plugin}")', profile)
            self.assertIn("(allow network*)", profile)
            self.assertIn(f'(subpath "{layout.repo_root}")', profile)
            self.assertIn(f'(subpath "{layout.evaluator_workspace}")', profile)
            self.assertIn('(literal "/usr/bin/security")', profile)
            self.assertNotIn(f'(subpath "{Path.home()}")', profile)

    @unittest.skipUnless(shutil.which("sandbox-exec"), "macOS sandbox-exec is unavailable")
    def test_real_claude_profile_reads_allowed_files_and_denies_sentinels(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            prefix = (
                str(layout.sandbox_executable),
                "-f",
                str(layout.claude_sandbox_profile),
            )
            for allowed in (
                layout.agent_workspace / "owners.json",
                layout.staged_plugin / ".claude-plugin" / "plugin.json",
            ):
                completed = subprocess.run(
                    prefix + ("/bin/cat", str(allowed)),
                    check=False,
                    shell=False,
                    capture_output=True,
                    timeout=10,
                )
                stderr = completed.stderr.decode("utf-8", errors="replace")
                if completed.returncode == 71 and "sandbox_apply: Operation not permitted" in stderr:
                    self.skipTest("nested sandbox-exec is prohibited by the test environment")
                self.assertEqual(
                    completed.returncode,
                    0,
                    stderr,
                )
            for forbidden in (
                prefix + ("/bin/cat", str(layout.repository_sentinel)),
                prefix + ("/bin/cat", str(layout.evaluator_sentinel)),
                prefix + ("/usr/bin/security", "help"),
            ):
                completed = subprocess.run(
                    forbidden,
                    check=False,
                    shell=False,
                    capture_output=True,
                    timeout=10,
                )
                self.assertNotEqual(completed.returncode, 0, forbidden)

    @unittest.skipUnless(shutil.which("codex"), "Codex CLI is unavailable")
    def test_real_codex_can_install_the_staged_marketplace_without_credentials(self) -> None:
        with TemporaryDirectory() as output:
            output_path = Path(output)
            layout = prepare_run(REPO_ROOT, output_path)
            self.addCleanup(layout.cleanup)
            codex_home = output_path / "credential-free-codex-home"
            codex_home.mkdir()
            environment = {
                "CODEX_HOME": str(codex_home),
                "HOME": str(layout.agent_workspace),
                "LANG": "C.UTF-8",
                "PATH": layout.minimal_path,
                "PYTHONNOUSERSITE": "1",
            }
            commands = (
                (
                    str(layout.codex_executable),
                    "plugin",
                    "marketplace",
                    "add",
                    str(layout.staged_marketplace),
                ),
                (
                    str(layout.codex_executable),
                    "plugin",
                    "add",
                    "python-scripting@python-scripting-test",
                    "--json",
                ),
                (str(layout.codex_executable), "plugin", "list", "--json"),
            )
            completed: subprocess.CompletedProcess[str] | None = None
            for command in commands:
                completed = subprocess.run(
                    command,
                    check=False,
                    shell=False,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    cwd=layout.agent_workspace,
                    env=environment,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)

            if completed is None:
                self.fail("marketplace smoke did not execute plugin list")
            listing: object = json.loads(completed.stdout)
            self.assertIsInstance(listing, dict)
            assert isinstance(listing, dict)
            plugins = listing.get("installed")
            self.assertIsInstance(plugins, list, completed.stdout)
            assert isinstance(plugins, list)
            self.assertTrue(
                any(
                    isinstance(plugin, dict)
                    and plugin.get("name") == "python-scripting"
                    and plugin.get("enabled") is True
                    for plugin in plugins
                )
            )


if __name__ == "__main__":
    unittest.main()
