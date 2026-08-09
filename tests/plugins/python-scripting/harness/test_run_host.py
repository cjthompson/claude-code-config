"""Command construction, credential transport, and host-isolation tests."""

from __future__ import annotations

from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from evaluate_run import evaluate_run
from prepare_run import RunLayout, prepare_run
from run_host import (
    _claude_final_response,
    _parse_codex_plugins,
    _read_beneath,
    _regular_files,
    build_claude_command,
    build_codex_command,
    run_host,
)
from trace_eval import Host


REPO_ROOT = Path(__file__).resolve().parents[4]
SECRET = "unit-test-credential-do-not-record"


class HostRunnerTests(unittest.TestCase):
    """Exercise real subprocess boundaries with local, non-networking fake CLIs."""

    def test_codex_command_keeps_global_flags_before_exec(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            command = build_codex_command(layout, "gpt-test")

            self.assertLess(command.index("--ask-for-approval"), command.index("exec"))
            self.assertLess(command.index("--strict-config"), command.index("exec"))
            self.assertLess(command.index("-C"), command.index("exec"))
            self.assertLess(command.index("--model"), command.index("exec"))
            self.assertIn("--skip-git-repo-check", command)
            self.assertIn("--ephemeral", command)
            self.assertIn("--json", command)
            self.assertEqual(command[-1], "-")
            self.assertNotIn("--sandbox", command)
            self.assertNotIn("--add-dir", command)

    def test_codex_plugin_inventory_accepts_real_installed_shape(self) -> None:
        output = json.dumps(
            {
                "available": [],
                "installed": [
                    {
                        "enabled": True,
                        "name": "python-scripting",
                        "pluginId": "python-scripting@python-scripting-test",
                    }
                ],
            }
        )

        self.assertEqual(_parse_codex_plugins(output), ("python-scripting",))

    @unittest.skipUnless(shutil.which("codex"), "Codex CLI is unavailable")
    def test_real_codex_global_flags_and_strict_config_accept_exec_help(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            command = build_codex_command(layout, "gpt-test")
            exec_index = command.index("exec")
            completed = subprocess.run(
                command[:exec_index] + ("exec", "--help"),
                check=False,
                shell=False,
                capture_output=True,
                text=True,
                timeout=30,
                cwd=layout.agent_workspace,
                env={
                    "CODEX_HOME": str(layout.codex_home),
                    "HOME": str(layout.agent_workspace),
                    "LANG": "C.UTF-8",
                    "PATH": layout.minimal_path,
                    "PYTHONNOUSERSITE": "1",
                },
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_codex_credential_reaches_only_login_stdin_and_agent_env_is_clean(self) -> None:
        with TemporaryDirectory() as output:
            output_path = Path(output)
            fake = self._write_fake_codex(output_path)
            layout = replace(
                prepare_run(REPO_ROOT, output_path),
                codex_executable=fake,
            )
            self.addCleanup(layout.cleanup)
            clean = {
                key: value
                for key, value in os.environ.items()
                if key not in {"OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"}
            }
            clean["OPENAI_API_KEY"] = SECRET

            with patch.dict(os.environ, clean, clear=True):
                completed = run_host(Host.CODEX, layout, "gpt-test")

            self.assertEqual(completed.validity.state, "VALID")
            observed = [
                json.loads(line)
                for line in (output_path / "codex-observed.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            login = next(item for item in observed if "login" in item["args"])
            agent = next(item for item in observed if "exec" in item["args"] and "--json" in item["args"])
            plugin_list = next(
                item
                for item in observed
                if item["args"][-3:] == ["plugin", "list", "--json"]
            )
            self.assertEqual(login["stdin"], "expected")
            self.assertEqual(login["openai"], "unset")
            self.assertEqual(login["access"], "unset")
            self.assertEqual(agent["openai"], "unset")
            self.assertEqual(agent["access"], "unset")
            self.assertEqual(agent["codex_home"], str(layout.codex_home))
            self.assertEqual(agent["home"], str(layout.agent_workspace))
            self.assertEqual(agent["cwd"], str(layout.agent_workspace))
            self.assertEqual(plugin_list["cwd"], str(layout.agent_workspace))
            self.assertEqual(completed.enabled_plugins, ("python-scripting",))
            self.assertNotEqual(agent["home"], str(Path.home()))
            self.assertFalse(layout.codex_home.exists())
            self._assert_secret_absent(layout, SECRET)

    def test_codex_access_token_uses_the_matching_login_mode(self) -> None:
        with TemporaryDirectory() as output:
            output_path = Path(output)
            fake = self._write_fake_codex(output_path)
            layout = replace(prepare_run(REPO_ROOT, output_path), codex_executable=fake)
            self.addCleanup(layout.cleanup)
            clean = {
                key: value
                for key, value in os.environ.items()
                if key not in {"OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"}
            }
            clean["CODEX_ACCESS_TOKEN"] = SECRET

            with patch.dict(os.environ, clean, clear=True):
                completed = run_host(Host.CODEX, layout, "gpt-test")

            self.assertEqual(completed.validity.state, "VALID")
            observed = [
                json.loads(line)
                for line in (output_path / "codex-observed.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]
            login = next(item for item in observed if "login" in item["args"])
            self.assertIn("--with-access-token", login["args"])
            self.assertEqual(login["stdin"], "expected")

    def test_codex_rejects_ambiguous_or_missing_credentials_without_starting_agent(self) -> None:
        for credentials in ({}, {"OPENAI_API_KEY": SECRET, "CODEX_ACCESS_TOKEN": SECRET}):
            with self.subTest(credentials=tuple(credentials)):
                with TemporaryDirectory() as output:
                    output_path = Path(output)
                    fake = self._write_fake_codex(output_path)
                    layout = replace(prepare_run(REPO_ROOT, output_path), codex_executable=fake)
                    self.addCleanup(layout.cleanup)
                    clean = {
                        key: value
                        for key, value in os.environ.items()
                        if key not in {"OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"}
                    }
                    clean.update(credentials)

                    with patch.dict(os.environ, clean, clear=True):
                        completed = run_host(Host.CODEX, layout, "gpt-test")

                    self.assertEqual(completed.validity.state, "INVALID")
                    self.assertTrue(completed.validity.reasons)
                    observed_path = output_path / "codex-observed.jsonl"
                    if observed_path.exists():
                        self.assertFalse(
                            any(
                                "exec" in json.loads(line)["args"]
                                for line in observed_path.read_text(encoding="utf-8").splitlines()
                            )
                        )

    def test_codex_rejects_foreign_plugin_inventory(self) -> None:
        with TemporaryDirectory() as output:
            output_path = Path(output)
            fake = self._write_fake_codex(
                output_path,
                plugins=("python-scripting", "foreign-plugin"),
            )
            layout = replace(prepare_run(REPO_ROOT, output_path), codex_executable=fake)
            self.addCleanup(layout.cleanup)
            clean = {
                key: value
                for key, value in os.environ.items()
                if key not in {"OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"}
            }
            clean["OPENAI_API_KEY"] = SECRET

            with patch.dict(os.environ, clean, clear=True):
                completed = run_host(Host.CODEX, layout, "gpt-test")

            self.assertEqual(completed.validity.state, "INVALID")
            self.assertIn("foreign-plugin", completed.enabled_plugins)
            self.assertTrue(any("plugin" in reason for reason in completed.validity.reasons))

    def test_codex_requires_successful_terminal_event_for_final_response(self) -> None:
        with TemporaryDirectory() as output:
            output_path = Path(output)
            fake = self._write_fake_codex(output_path, terminal_event=False)
            layout = replace(prepare_run(REPO_ROOT, output_path), codex_executable=fake)
            self.addCleanup(layout.cleanup)
            clean = {
                key: value
                for key, value in os.environ.items()
                if key not in {"OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"}
            }
            clean["OPENAI_API_KEY"] = SECRET

            with patch.dict(os.environ, clean, clear=True):
                completed = run_host(Host.CODEX, layout, "gpt-test")

            self.assertEqual(completed.validity.state, "INVALID")
            self.assertEqual(completed.final_response, "")
            self.assertTrue(any("terminal" in reason for reason in completed.validity.reasons))

    def test_status_and_metadata_bind_traced_final_response_digest(self) -> None:
        with TemporaryDirectory() as output:
            output_path = Path(output)
            fake = self._write_fake_codex(output_path, response="bound response")
            layout = replace(prepare_run(REPO_ROOT, output_path), codex_executable=fake)
            self.addCleanup(layout.cleanup)
            clean = {
                key: value
                for key, value in os.environ.items()
                if key not in {"OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"}
            }
            clean["OPENAI_API_KEY"] = SECRET

            with patch.dict(os.environ, clean, clear=True):
                completed = run_host(Host.CODEX, layout, "gpt-test")

            expected = hashlib.sha256(b"bound response").hexdigest()
            status = json.loads(
                (layout.evaluator_workspace / "run-status.json").read_text(encoding="utf-8")
            )
            metadata = json.loads(layout.metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(completed.final_response, "bound response")
            self.assertEqual(status["final_response_sha256"], expected)
            self.assertEqual(metadata["final_response_sha256"], expected)
            evidence_path = layout.evaluator_workspace / "host-evidence.json"
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            self.assertEqual(
                status["host_evidence_sha256"],
                hashlib.sha256(evidence_path.read_bytes()).hexdigest(),
            )
            self.assertEqual(
                evidence["baseline_hashes_sha256"],
                layout.baseline_hashes_sha256,
            )
            post_path = layout.evaluator_workspace / "post-run-hashes.json"
            self.assertEqual(
                evidence["post_run_hashes_sha256"],
                hashlib.sha256(post_path.read_bytes()).hexdigest(),
            )
            self.assertEqual(evidence["final_response_sha256"], expected)

    def test_run_host_origin_evidence_is_accepted_by_evaluator(self) -> None:
        with TemporaryDirectory() as output:
            output_path = Path(output)
            fake = self._write_fake_codex(output_path, response="done")
            layout = replace(prepare_run(REPO_ROOT, output_path), codex_executable=fake)
            self.addCleanup(layout.cleanup)
            clean = {
                key: value
                for key, value in os.environ.items()
                if key not in {"OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"}
            }
            clean["OPENAI_API_KEY"] = SECRET

            with patch.dict(os.environ, clean, clear=True):
                completed = run_host(Host.CODEX, layout, "gpt-test")
            report = evaluate_run(
                layout,
                Host.CODEX,
                completed.trace_path,
                completed.final_response,
            )

            self.assertEqual(completed.validity.state, "VALID")
            self.assertEqual(report.validity.state, "VALID")
            self.assertEqual(report.discovery.state, "FAIL")

    def test_claude_command_is_ephemeral_streaming_and_has_exact_tools(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            command = build_claude_command(layout, "claude-sonnet-5")

            self.assertEqual(command[:3], (str(layout.sandbox_executable), "-f", str(layout.claude_sandbox_profile)))
            self.assertIn("--setting-sources", command)
            self.assertIn("--strict-mcp-config", command)
            self.assertEqual(command[command.index("--setting-sources") + 1], "project,local")
            self.assertEqual(command[command.index("--plugin-dir") + 1], str(layout.staged_plugin))
            self.assertIn("--no-session-persistence", command)
            self.assertIn("stream-json", command)
            self.assertEqual(
                command[command.index("--tools") + 1],
                "Read,Glob,Grep,Bash,Write,Edit,Skill",
            )
            self.assertEqual(
                command[command.index("--allowedTools") + 1],
                "Read,Glob,Grep,Bash,Write,Edit,Skill",
            )
            for forbidden in ("WebFetch", "WebSearch", "Task", "NotebookEdit"):
                self.assertNotIn(forbidden, command)

    def test_claude_final_response_requires_successful_terminal_result(self) -> None:
        records: tuple[dict[str, object], ...] = (
            {"type": "result", "subtype": "error", "result": "not successful"},
            {"type": "result", "subtype": "success", "is_error": True, "result": "error"},
        )
        for record in records:
            with self.subTest(record=record), self.assertRaisesRegex(
                ValueError,
                "successful terminal",
            ):
                _claude_final_response((record,))

    def test_claude_is_invalid_before_agent_when_parent_only_network_is_unsupported(self) -> None:
        with TemporaryDirectory() as output:
            output_path = Path(output)
            claude = self._write_fake_claude(output_path, include_foreign_plugin=False)
            sandbox = self._write_fake_sandbox(output_path)
            layout = replace(
                prepare_run(REPO_ROOT, output_path),
                claude_executable=claude,
                sandbox_executable=sandbox,
            )
            self.addCleanup(layout.cleanup)

            completed = run_host(Host.CLAUDE, layout, "claude-sonnet-5")

            self.assertEqual(completed.validity.state, "INVALID")
            self.assertTrue(
                any("parent-only network" in reason for reason in completed.validity.reasons)
            )
            sandbox_calls = (output_path / "sandbox-observed.log").read_text(encoding="utf-8")
            self.assertIn(str(layout.agent_workspace / "owners.json"), sandbox_calls)
            self.assertIn(str(layout.staged_plugin / ".claude-plugin" / "plugin.json"), sandbox_calls)
            self.assertIn(str(layout.repository_sentinel), sandbox_calls)
            self.assertIn(str(layout.evaluator_sentinel), sandbox_calls)
            self.assertIn("/usr/bin/security", sandbox_calls)
            self.assertIn(f"{layout.claude_executable} --version", sandbox_calls)
            self.assertEqual(completed.enabled_plugins, ())
            self.assertFalse((output_path / "claude-observed.json").exists())
            trace_calls = sandbox_calls.splitlines()
            self.assertFalse(any(" --output-format stream-json " in call for call in trace_calls))

    def test_claude_unsupported_boundary_prevents_foreign_plugin_from_running(self) -> None:
        with TemporaryDirectory() as output:
            output_path = Path(output)
            layout = replace(
                prepare_run(REPO_ROOT, output_path),
                claude_executable=self._write_fake_claude(output_path, include_foreign_plugin=True),
                sandbox_executable=self._write_fake_sandbox(output_path),
            )
            self.addCleanup(layout.cleanup)

            completed = run_host(Host.CLAUDE, layout, "claude-sonnet-5")

            self.assertEqual(completed.validity.state, "INVALID")
            self.assertTrue(any("parent-only network" in reason for reason in completed.validity.reasons))
            self.assertEqual(completed.enabled_plugins, ())
            metadata = json.loads(layout.metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(metadata["enabled_plugins"], [])
            self.assertFalse((output_path / "claude-observed.json").exists())

    def test_agent_symlink_invalidates_without_parent_read_or_overwrite(self) -> None:
        with TemporaryDirectory() as output:
            output_path = Path(output)
            outside = output_path / "outside-secret.txt"
            outside.write_text(SECRET, encoding="utf-8")
            fake = self._write_fake_codex(output_path, symlink_target=outside)
            layout = replace(prepare_run(REPO_ROOT, output_path), codex_executable=fake)
            self.addCleanup(layout.cleanup)
            clean = {
                key: value
                for key, value in os.environ.items()
                if key not in {"OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"}
            }
            clean["OPENAI_API_KEY"] = SECRET

            with patch.dict(os.environ, clean, clear=True):
                completed = run_host(Host.CODEX, layout, "gpt-test")

            self.assertEqual(completed.validity.state, "INVALID")
            self.assertTrue(any("symlink" in reason for reason in completed.validity.reasons))
            self.assertEqual(outside.read_text(encoding="utf-8"), SECRET)

    def test_workspace_root_symlink_is_rejected_without_traversing_target(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            outside = root / "outside"
            outside.mkdir()
            secret = outside / "secret.txt"
            secret.write_text(SECRET, encoding="utf-8")
            workspace = root / "workspace"
            workspace.symlink_to(outside, target_is_directory=True)

            files, reasons = _regular_files(workspace)

            self.assertEqual(files, ())
            self.assertTrue(any("root" in reason and "symlink" in reason for reason in reasons))
            self.assertEqual(secret.read_text(encoding="utf-8"), SECRET)

    def test_root_anchored_read_rejects_nested_parent_symlink(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            outside = root / "outside"
            outside.mkdir()
            (outside / "secret.txt").write_text(SECRET, encoding="utf-8")
            (workspace / "nested").symlink_to(outside, target_is_directory=True)

            with self.assertRaises(OSError):
                _read_beneath(workspace, Path("nested/secret.txt"))

            self.assertEqual(
                (outside / "secret.txt").read_text(encoding="utf-8"),
                SECRET,
            )

    def test_returned_final_response_is_redacted_if_host_echoes_a_credential(self) -> None:
        with TemporaryDirectory() as output:
            output_path = Path(output)
            fake = self._write_fake_codex(output_path, response=SECRET)
            layout = replace(prepare_run(REPO_ROOT, output_path), codex_executable=fake)
            self.addCleanup(layout.cleanup)
            clean = {
                key: value
                for key, value in os.environ.items()
                if key not in {"OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"}
            }
            clean["OPENAI_API_KEY"] = SECRET

            with patch.dict(os.environ, clean, clear=True):
                completed = run_host(Host.CODEX, layout, "gpt-test")

            self.assertEqual(completed.validity.state, "INVALID")
            self.assertNotIn(SECRET, completed.final_response)
            self.assertIn("<redacted>", completed.final_response)

    def test_nonzero_agent_exit_is_retained_in_status_metadata(self) -> None:
        with TemporaryDirectory() as output:
            output_path = Path(output)
            fake = self._write_fake_codex(output_path, agent_exit_code=17)
            layout = replace(prepare_run(REPO_ROOT, output_path), codex_executable=fake)
            self.addCleanup(layout.cleanup)
            clean = {
                key: value
                for key, value in os.environ.items()
                if key not in {"OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"}
            }
            clean["OPENAI_API_KEY"] = SECRET

            with patch.dict(os.environ, clean, clear=True):
                completed = run_host(Host.CODEX, layout, "gpt-test")

            self.assertEqual(completed.validity.state, "INVALID")
            self.assertEqual(completed.exit_code, 17)
            metadata = json.loads(layout.metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(metadata["exit_code"], 17)

    def _write_fake_codex(
        self,
        root: Path,
        *,
        symlink_target: Path | None = None,
        response: str = "done",
        agent_exit_code: int = 0,
        plugins: tuple[str, ...] = ("python-scripting",),
        terminal_event: bool = True,
    ) -> Path:
        path = root / "codex"
        path.write_text(
            "#!/bin/sh\n"
            "set -eu\n"
            "observed=\"$(dirname \"$CODEX_HOME\")/../codex-observed.jsonl\"\n"
            "openai=unset; test \"${OPENAI_API_KEY+x}\" != x || openai=set\n"
            "access=unset; test \"${CODEX_ACCESS_TOKEN+x}\" != x || access=set\n"
            "stdin_state=none\n"
            "case \" $* \" in\n"
            "  *\" login \"*) IFS= read -r credential || true; "
            f"test \"$credential\" = \"{SECRET}\" && stdin_state=expected || stdin_state=wrong ;;\n"
            "esac\n"
            "export openai_state=\"$openai\" access_state=\"$access\" stdin_state\n"
            "python3 -c 'import json, os, sys; print(json.dumps({\"args\":sys.argv[1:],\"openai\":os.environ.get(\"openai_state\"),\"access\":os.environ.get(\"access_state\"),\"stdin\":os.environ.get(\"stdin_state\"),\"codex_home\":os.environ[\"CODEX_HOME\"],\"home\":os.environ[\"HOME\"],\"cwd\":os.getcwd()}))' "
            "\"$@\" >> \"$observed\"\n"
            "case \" $* \" in\n"
            "  *\" --version \"*) echo 'codex-cli 0.147.0' ;;\n"
            "  *\" doctor \"*) echo '{\"config\":{\"valid\":true,\"strict\":true},\"authentication\":{\"valid\":true},\"permissions\":{\"profile\":\"python-scripting-test\",\"filesystem\":{\"workspace_write\":true},\"network\":{\"enabled\":false}}}' ;;\n"
            f"  *\" plugin list --json \"*) echo '{json.dumps({'plugins': [{'name': plugin, 'enabled': True} for plugin in plugins]}, separators=(',', ':'))}' ;;\n"
            "  *\" exec --help \"*) echo 'Usage: codex exec' ;;\n"
            "  *\" exec \"*\" --json \"*) "
            + (
                f"ln -s '{symlink_target}' \"$HOME/leak-link\"; "
                if symlink_target is not None
                else ""
            )
            + "echo '{\"type\":\"thread.started\",\"thread_id\":\"fake\"}'; "
            + f"echo '{json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': response}}, separators=(',', ':'))}'; "
            + (
                "echo '{\"type\":\"turn.completed\",\"usage\":{}}'; "
                if terminal_event
                else ""
            )
            + f"exit {agent_exit_code} ;;\n"
            "esac\n",
            encoding="utf-8",
        )
        path.chmod(0o700)
        return path

    def _write_fake_claude(self, root: Path, *, include_foreign_plugin: bool) -> Path:
        path = root / ("claude-foreign" if include_foreign_plugin else "claude")
        plugins = [
            {"name": "python-scripting", "builtin": False},
            {"name": "core", "builtin": True},
        ]
        if include_foreign_plugin:
            plugins.append({"name": "foreign-plugin", "builtin": False})
        path.write_text(
            "#!/bin/sh\n"
            "set -eu\n"
            f"observed='{root / 'claude-observed.json'}'\n"
            "if test \"${1-}\" = --version; then echo '2.1.226'; exit 0; fi\n"
            "python3 -c 'import json, os; print(json.dumps({\"home\":os.environ[\"HOME\"],\"cwd\":os.getcwd(),\"openai\":\"set\" if \"OPENAI_API_KEY\" in os.environ else \"unset\",\"access\":\"set\" if \"CODEX_ACCESS_TOKEN\" in os.environ else \"unset\"}))' > \"$observed\"\n"
            f"printf '%s\\n' '{json.dumps({'type': 'system', 'subtype': 'init', 'plugins': plugins}, separators=(',', ':'))}'\n"
            "printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"done\"}'\n",
            encoding="utf-8",
        )
        path.chmod(0o700)
        return path

    def _write_fake_sandbox(self, root: Path) -> Path:
        path = root / "sandbox-exec"
        path.write_text(
            "#!/bin/sh\n"
            "set -eu\n"
            f"printf '%s\\n' \"$*\" >> '{root / 'sandbox-observed.log'}'\n"
            "test \"$1\" = -f\n"
            "shift 2\n"
            "case \" $* \" in\n"
            "  *deny-sentinel*|*package.json*|*'/usr/bin/security'*) exit 77 ;;\n"
            "esac\n"
            "exec \"$@\"\n",
            encoding="utf-8",
        )
        path.chmod(0o700)
        return path

    def _assert_secret_absent(self, layout: RunLayout, secret: str) -> None:
        encoded = secret.encode()
        for root in (
            layout.agent_workspace,
            layout.staged_marketplace,
            layout.evaluator_workspace,
        ):
            for path in root.rglob("*"):
                if path.is_file():
                    self.assertNotIn(encoded, path.read_bytes(), path)


if __name__ == "__main__":
    unittest.main()
