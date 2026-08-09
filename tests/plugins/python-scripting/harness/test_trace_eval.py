"""Decision-table tests for host trace discovery evidence."""

from __future__ import annotations

from dataclasses import fields
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from trace_eval import (
    Host,
    Evidence,
    NormalizedEvent,
    TraceAnalysis,
    TraceFormatError,
    VerdictState,
    analyze_trace,
    is_python_action,
)


TRACE_ROOT = Path(__file__).parent / "fixtures" / "traces"


def trace(name: str) -> Path:
    """Return a hand-authored trace fixture by name."""
    return TRACE_ROOT / name


class TraceDiscoveryTests(unittest.TestCase):
    """Exercise the observable discovery decision table with real JSONL."""

    def test_claude_skill_before_write_passes(self) -> None:
        result = analyze_trace(Host.CLAUDE, trace("claude-skill-before-write.jsonl"))

        self.assertEqual(result.discovery.state, VerdictState.PASS)
        self.assertEqual(result.python_actions[0].event_id, "write-helper")
        self.assertEqual(result.skill_events[0].event_id, "skill-simple")
        self.assertEqual(result.sources[0].source, "print('ready')\n")

    def test_initial_claude_skill_inventory_is_not_evidence(self) -> None:
        result = analyze_trace(Host.CLAUDE, trace("claude-inventory-only.jsonl"))

        self.assertEqual(result.discovery.state, VerdictState.FAIL)
        self.assertEqual(result.skill_events, ())

    def test_codex_skill_resource_before_exec_passes(self) -> None:
        result = analyze_trace(
            Host.CODEX, trace("codex-skill-read-before-exec.jsonl")
        )

        self.assertEqual(result.discovery.state, VerdictState.PASS)
        self.assertEqual(result.skill_events[0].kind, "codex-skill-read")
        self.assertEqual(result.commands[0].command, "python3 -m json.tool data.json")

    def test_silent_codex_with_python_is_unobservable(self) -> None:
        result = analyze_trace(Host.CODEX, trace("codex-silent-before-exec.jsonl"))

        self.assertEqual(result.discovery.state, VerdictState.UNOBSERVABLE)

    def test_evidence_after_first_python_action_fails(self) -> None:
        result = analyze_trace(Host.CODEX, trace("python-before-skill.jsonl"))

        self.assertEqual(result.discovery.state, VerdictState.FAIL)
        self.assertLess(result.python_actions[0].position, result.skill_events[0].position)

    def test_no_python_always_fails(self) -> None:
        result = analyze_trace(Host.CODEX, trace("no-python.jsonl"))

        self.assertEqual(result.discovery.state, VerdictState.FAIL)
        self.assertEqual(result.python_actions, ())

    def test_combined_heredoc_captures_source_and_command(self) -> None:
        result = analyze_trace(Host.CLAUDE, trace("combined-heredoc.jsonl"))

        self.assertEqual(result.discovery.state, VerdictState.PASS)
        self.assertEqual(len(result.python_actions), 1)
        self.assertEqual(len(result.commands), 1)
        self.assertEqual(result.sources[0].origin, "heredoc")
        self.assertEqual(result.sources[0].source, "print('combined')\n")

    def test_native_codex_resource_uri_before_exec_passes_after_completion(self) -> None:
        uri_result = self._analyze_codex_records(
            (
                {
                    "type": "resource_read",
                    "id": "skill-resource",
                    "uri": "file:///stage/python-simple-scripts/SKILL.md",
                    "status": "completed",
                },
                {
                    "type": "item.completed",
                    "item": {
                        "id": "run",
                        "type": "command_execution",
                        "command": "python3 helper.py",
                    },
                },
            )
        )
        path_result = self._analyze_codex_records(
            (
                {
                    "type": "resource",
                    "id": "skill-resource-path",
                    "path": "/stage/python-simple-scripts/SKILL.md",
                    "status": "success",
                },
                {
                    "type": "item.completed",
                    "item": {
                        "id": "run",
                        "type": "command_execution",
                        "command": "python3 helper.py",
                    },
                },
            )
        )

        self.assertEqual(uri_result.discovery.state, VerdictState.PASS)
        self.assertEqual(uri_result.skill_events[0].event_id, "skill-resource")
        self.assertEqual(path_result.discovery.state, VerdictState.PASS)
        self.assertEqual(path_result.skill_events[0].event_id, "skill-resource-path")

    def test_requested_or_failed_skill_calls_do_not_pass(self) -> None:
        requested = self._analyze_claude_records(
            (
                self._tool_use("skill", "Skill", {"skill": "python-scripting:python-simple-scripts"}),
                self._tool_use("write", "Write", {"file_path": "helper.py", "content": "print(1)"}),
            )
        )
        failed = self._analyze_codex_records(
            (
                {
                    "type": "item.completed",
                    "item": {
                        "id": "skill-resource",
                        "type": "resource_read",
                        "uri": "file:///stage/python-simple-scripts/SKILL.md",
                        "status": "error",
                        "output": "error text must not be mistaken for success",
                    },
                },
                {
                    "type": "item.completed",
                    "item": {"id": "run", "type": "command_execution", "command": "python3 helper.py"},
                },
            )
        )
        incomplete = self._analyze_codex_records(
            (
                {
                    "type": "resource_read",
                    "id": "skill-resource",
                    "uri": "file:///stage/python-simple-scripts/SKILL.md",
                },
                {
                    "type": "item.completed",
                    "item": {"id": "run", "type": "command_execution", "command": "python3 helper.py"},
                },
            )
        )

        self.assertEqual(requested.discovery.state, VerdictState.FAIL)
        self.assertEqual(failed.discovery.state, VerdictState.FAIL)
        self.assertEqual(incomplete.discovery.state, VerdictState.FAIL)
        self.assertEqual(requested.skill_events, ())
        self.assertEqual(failed.skill_events, ())

    def test_codex_resource_completion_uses_the_matching_call_id(self) -> None:
        result = self._analyze_codex_records(
            (
                {
                    "type": "resource_read",
                    "id": "skill-resource",
                    "uri": "file:///stage/python-simple-scripts/SKILL.md",
                },
                {
                    "type": "resource_read_result",
                    "call_id": "skill-resource",
                    "status": "completed",
                    "content": "loaded",
                },
                {
                    "type": "item.completed",
                    "item": {"id": "run", "type": "command_execution", "command": "python3 helper.py"},
                },
            )
        )

        self.assertEqual(result.discovery.state, VerdictState.PASS)
        self.assertEqual(result.skill_events[0].event_id, "skill-resource")

    def test_same_claude_content_order_controls_discovery(self) -> None:
        skill_then_write = self._analyze_claude_records(
            (
                {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {"type": "tool_use", "id": "skill", "name": "Skill", "input": {"skill": "python-scripting:python-simple-scripts"}},
                            {"type": "tool_result", "tool_use_id": "skill", "is_error": False, "content": "result"},
                            {"type": "tool_use", "id": "write", "name": "Write", "input": {"file_path": "helper.py", "content": "print(1)"}},
                        ]
                    },
                },
            )
        )
        write_then_skill = self._analyze_claude_records(
            (
                {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {"type": "tool_use", "id": "write", "name": "Write", "input": {"file_path": "helper.py", "content": "print(1)"}},
                            {"type": "tool_use", "id": "skill", "name": "Skill", "input": {"skill": "python-scripting:python-simple-scripts"}},
                            {"type": "tool_result", "tool_use_id": "skill", "is_error": False, "content": "result"},
                        ]
                    },
                },
            )
        )

        self.assertEqual(skill_then_write.discovery.state, VerdictState.PASS)
        self.assertEqual(write_then_skill.discovery.state, VerdictState.FAIL)
        self.assertLess(
            skill_then_write.skill_events[0].position,
            skill_then_write.python_actions[0].position,
        )

    def test_completion_position_controls_discovery_ordering(self) -> None:
        action_before_completion = self._analyze_claude_records(
            (
                self._tool_use(
                    "skill", "Skill", {"skill": "python-scripting:python-simple-scripts"}
                ),
                self._tool_use(
                    "write", "Write", {"file_path": "helper.py", "content": "print(1)"}
                ),
                self._tool_result("skill", False),
            )
        )
        completion_before_action = self._analyze_claude_records(
            (
                self._tool_use(
                    "skill", "Skill", {"skill": "python-scripting:python-simple-scripts"}
                ),
                self._tool_result("skill", False),
                self._tool_use(
                    "write", "Write", {"file_path": "helper.py", "content": "print(1)"}
                ),
            )
        )

        self.assertEqual(action_before_completion.discovery.state, VerdictState.FAIL)
        self.assertEqual(completion_before_action.discovery.state, VerdictState.PASS)
        self.assertGreater(
            action_before_completion.skill_events[0].position,
            action_before_completion.python_actions[0].position,
        )

    def test_public_trace_records_have_exact_frozen_schemas(self) -> None:
        self.assertTrue(NormalizedEvent.__dataclass_params__.frozen)
        self.assertTrue(Evidence.__dataclass_params__.frozen)
        self.assertEqual(
            tuple(field.name for field in fields(NormalizedEvent)),
            ("position", "event_id", "tool_name", "input", "output"),
        )
        self.assertEqual(
            tuple(field.name for field in fields(Evidence)),
            ("position", "event_id", "kind", "detail"),
        )

    def _analyze_claude_records(
        self, records: tuple[dict[str, object], ...]
    ) -> TraceAnalysis:
        return self._analyze_records(Host.CLAUDE, records)

    def _analyze_codex_records(
        self, records: tuple[dict[str, object], ...]
    ) -> TraceAnalysis:
        return self._analyze_records(Host.CODEX, records)

    def _analyze_records(
        self, host: Host, records: tuple[dict[str, object], ...]
    ) -> TraceAnalysis:
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "trace.jsonl"
            path.write_text(
                "\n".join(json.dumps(record) for record in records) + "\n",
                encoding="utf-8",
            )
            return analyze_trace(host, path)

    def _tool_use(
        self, event_id: str, name: str, input_value: dict[str, object]
    ) -> dict[str, object]:
        return {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": event_id, "name": name, "input": input_value}]}}

    def _tool_result(self, event_id: str, is_error: bool) -> dict[str, object]:
        return {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": event_id, "is_error": is_error, "content": "result"}]}}


class PythonActionTests(unittest.TestCase):
    """Cover executable and source-construction forms without prose matches."""

    def test_detects_python_actions(self) -> None:
        cases = (
            ("Write", {"file_path": "helper.py", "content": "print(1)"}),
            ("Edit", {"path": "helper.py", "old_string": "x", "new_string": "y"}),
            ("apply_patch", {"patch": "*** Add File: helper.py\n+print(1)\n"}),
            ("Bash", {"command": "cat > helper.py <<'PY'\nprint(1)\nPY"}),
            ("Bash", {"command": "printf 'print(1)' > helper.py"}),
            ("Bash", {"command": "python -c 'print(1)'"}),
            ("Bash", {"command": "python3.11 -m json.tool data.json"}),
            ("Bash", {"command": "/usr/local/bin/python3 - < input.py"}),
            ("Bash", {"command": "env MODE=test python3 helper.py"}),
            ("Bash", {"command": "cat > helper.py <<'PY'\nprint(1)\nPY\npython3 helper.py"}),
        )

        for tool_name, tool_input in cases:
            with self.subTest(tool_name=tool_name, tool_input=tool_input):
                self.assertTrue(is_python_action(tool_name, tool_input))

    def test_does_not_treat_prose_as_python_action(self) -> None:
        self.assertFalse(
            is_python_action("Bash", {"command": "echo 'python would be useful later'"})
        )
        self.assertFalse(
            is_python_action("message", {"text": "I will use python later."})
        )
        self.assertFalse(
            is_python_action(
                "Bash", {"command": "echo 'run helper.py later' > notes.txt"}
            )
        )
        self.assertFalse(
            is_python_action(
                "Bash", {"command": "echo 'write > helper.py later'"}
            )
        )

    def test_captures_standard_and_implicit_stdin_heredocs(self) -> None:
        standard = self._analyze_shell("cat <<'PY' > helper.py\nprint('standard')\nPY")
        implicit_stdin = self._analyze_shell("python3 <<'PY'\nprint('stdin')\nPY")

        self.assertEqual(standard.sources[0].source, "print('standard')\n")
        self.assertEqual(standard.sources[0].path, "helper.py")
        self.assertEqual(implicit_stdin.sources[0].source, "print('stdin')\n")
        self.assertIsNone(implicit_stdin.sources[0].path)

    def test_snapshot_recovers_full_source_after_partial_edit(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "snapshot.jsonl"
            path.write_text(
                "\n".join(
                    (
                        json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "edit", "name": "Edit", "input": {"path": "helper.py", "old_string": "x", "new_string": "y"}}]}}),
                        json.dumps({"type": "source_snapshot", "id": "post-run-helper", "path": "helper.py", "content": "print('snapshot')\n"}),
                    )
                )
                + "\n",
                encoding="utf-8",
            )

            result = analyze_trace(Host.CLAUDE, path)

        self.assertTrue(result.source_observable)
        self.assertEqual(result.sources[-1].origin, "snapshot")
        self.assertEqual(result.sources[-1].event_id, "post-run-helper")

    def _analyze_shell(self, command: str) -> TraceAnalysis:
        return TraceDiscoveryTests()._analyze_claude_records(
            (
                {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "bash",
                                "name": "Bash",
                                "input": {"command": command},
                            }
                        ]
                    },
                },
            )
        )

    def test_partial_edit_is_unobservable_without_later_snapshot(self) -> None:
        result = analyze_trace(Host.CODEX, trace("python-before-skill.jsonl"))

        self.assertFalse(result.source_observable)

    def test_captures_added_patch_and_python_c_bodies(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "capture.jsonl"
            path.write_text(
                "\n".join(
                    (
                        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"patch","name":"apply_patch","input":{"patch":"*** Add File: helper.py\\n+print(\'patch\')\\n"}}]}}',
                        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"command","name":"Bash","input":{"command":"python3 -c \\\"print(\'command\')\\\""}}]}}',
                    )
                )
                + "\n",
                encoding="utf-8",
            )

            result = analyze_trace(Host.CLAUDE, path)

        self.assertEqual(
            tuple((source.origin, source.source) for source in result.sources),
            (("patch", "print('patch')\n"), ("python-c", "print('command')")),
        )

    def test_later_full_write_resolves_partial_edit_source(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "resolved.jsonl"
            path.write_text(
                "\n".join(
                    (
                        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"edit","name":"Edit","input":{"path":"helper.py","old_string":"x","new_string":"y"}}]}}',
                        '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"write","name":"Write","input":{"file_path":"helper.py","content":"print(1)\\n"}}]}}',
                    )
                )
                + "\n",
                encoding="utf-8",
            )

            result = analyze_trace(Host.CLAUDE, path)

        self.assertTrue(result.source_observable)
        self.assertEqual(result.sources[0].source, "print(1)\n")

    def test_normalizes_codex_command_execution_items(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "codex-command.jsonl"
            path.write_text(
                '{"type":"item.completed","item":{"id":"run","type":"command_execution","command":"env MODE=test python3 helper.py","aggregated_output":"done\\n","exit_code":0,"status":"completed"}}\n',
                encoding="utf-8",
            )

            result = analyze_trace(Host.CODEX, path)

        self.assertEqual(result.python_actions[0].event_id, "run")
        self.assertEqual(result.commands[0].command, "env MODE=test python3 helper.py")
        self.assertEqual(
            result.python_actions[0].output,
            {"exit_code": 0, "output": "done\n", "status": "completed"},
        )

    def test_normalizes_real_codex_file_change_items_as_python_actions(self) -> None:
        result = TraceDiscoveryTests()._analyze_codex_records(
            (
                {
                    "type": "item.completed",
                    "item": {
                        "changes": [{"kind": "add", "path": "helper.py"}],
                        "id": "change",
                        "status": "completed",
                        "type": "file_change",
                    },
                },
            )
        )

        self.assertEqual(len(result.python_actions), 1)
        self.assertEqual(result.python_actions[0].event_id, "change")
        self.assertEqual(result.python_actions[0].tool_name, "file_change")
        self.assertFalse(result.source_observable)

    def test_captures_every_shell_command_not_only_python_actions(self) -> None:
        result = TraceDiscoveryTests()._analyze_codex_records(
            (
                {
                    "type": "item.completed",
                    "item": {
                        "aggregated_output": "blocked",
                        "command": "curl https://example.invalid/payload",
                        "exit_code": 6,
                        "id": "network",
                        "status": "failed",
                        "type": "command_execution",
                    },
                },
                {
                    "type": "item.completed",
                    "item": {
                        "aggregated_output": "",
                        "command": "python3 helper.py owners.json",
                        "exit_code": 0,
                        "id": "run",
                        "status": "completed",
                        "type": "command_execution",
                    },
                },
            )
        )

        self.assertEqual(
            tuple(command.command for command in result.commands),
            (
                "curl https://example.invalid/payload",
                "python3 helper.py owners.json",
            ),
        )

    def test_partial_unified_patch_does_not_invent_source(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "partial-patch.jsonl"
            path.write_text(
                '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"patch","name":"apply_patch","input":{"patch":"diff --git a/helper.py b/helper.py\\n--- a/helper.py\\n+++ b/helper.py\\n@@ -1 +1 @@\\n+print(1)\\n"}}]}}\n',
                encoding="utf-8",
            )

            result = analyze_trace(Host.CLAUDE, path)

        self.assertEqual(result.sources, ())
        self.assertFalse(result.source_observable)


class TraceFormatTests(unittest.TestCase):
    """Malformed traces must retain their source line in diagnostics."""

    def test_malformed_json_names_its_line(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "bad.jsonl"
            path.write_text('{"type":"assistant"}\nnot-json\n', encoding="utf-8")

            with self.assertRaisesRegex(TraceFormatError, r"line 2"):
                analyze_trace(Host.CLAUDE, path)

    def test_non_object_json_names_its_line(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "bad.jsonl"
            path.write_text("[]\n", encoding="utf-8")

            with self.assertRaisesRegex(TraceFormatError, r"line 1"):
                analyze_trace(Host.CODEX, path)

    def test_empty_jsonl_line_names_its_line(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "bad.jsonl"
            path.write_text('{"type":"thread.started"}\n\n', encoding="utf-8")

            with self.assertRaisesRegex(TraceFormatError, r"line 2"):
                analyze_trace(Host.CODEX, path)


if __name__ == "__main__":
    unittest.main()
