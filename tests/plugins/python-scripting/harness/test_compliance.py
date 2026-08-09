"""Mechanical and reviewed compliance checks for incidental helpers."""

from __future__ import annotations

import sys
import unittest

from compliance import (
    ComplianceInputs,
    Finding,
    evaluate_compliance,
    evaluate_probe,
    inspect_commands,
    inspect_source,
)
from trace_eval import CapturedCommand, NormalizedEvent, VerdictState


STDLIB = frozenset(sys.stdlib_module_names)


def command(text: str) -> CapturedCommand:
    """Create a captured command with irrelevant trace identity."""
    return CapturedCommand(1, "call-1", text)


def probe_event(
    input_value: object,
    output_value: object,
) -> NormalizedEvent:
    """Create one normalized probe event."""
    return NormalizedEvent(1, "probe", "probe_run", input_value, output_value)


class ComplianceTests(unittest.TestCase):
    """Exercise every objective rule separately from human review."""

    def assert_finding(self, findings: tuple[Finding, ...], code: str) -> None:
        self.assertIn(code, tuple(finding.code for finding in findings))

    def assert_no_finding(self, findings: tuple[Finding, ...], code: str) -> None:
        self.assertNotIn(code, tuple(finding.code for finding in findings))

    def test_rejects_incomplete_signature(self) -> None:
        findings = inspect_source("def load() -> list[dict]: ...", STDLIB)

        self.assert_finding(findings, "bare-container-annotation")

    def test_rejects_missing_parameter_and_return_annotations(self) -> None:
        findings = inspect_source("def load(path):\n    return path\n", STDLIB)

        self.assert_finding(findings, "missing-annotation")

    def test_rejects_bare_annotation_containers_only_in_annotations(self) -> None:
        findings = inspect_source(
            "def load() -> tuple[int, ...]:\n"
            "    local: list = []\n"
            "    return (1,)\n",
            STDLIB,
        )

        self.assert_finding(findings, "bare-container-annotation")

    def test_allows_inferred_local_containers(self) -> None:
        findings = inspect_source(
            "def load(raw: object) -> list[str]:\n"
            "    values = []\n"
            "    if isinstance(raw, str):\n"
            "        values.append(raw)\n"
            "    return values\n",
            STDLIB,
        )

        self.assert_no_finding(findings, "bare-container-annotation")

    def test_rejects_dynamic_typing_escapes(self) -> None:
        findings = inspect_source(
            "from typing import Any, cast\n"
            "def load(raw: object) -> str:\n"
            "    value: Any = cast(str, raw)  # type: ignore[assignment]\n"
            "    return value\n",
            STDLIB,
        )

        self.assert_finding(findings, "dynamic-typing-escape")

    def test_rejects_dynamic_typing_aliases_and_tempfile_aliases(self) -> None:
        findings = inspect_source(
            "import json as j\n"
            "import typing as t\n"
            "from tempfile import mktemp\n"
            "from typing import Any as A, cast as convert\n"
            "def load(text: str) -> str:\n"
            "    root: object = j.loads(text)\n"
            "    value: A = convert(str, root)\n"
            "    path = mktemp()\n"
            "    return value + path\n",
            STDLIB,
        )

        self.assert_finding(findings, "dynamic-typing-escape")
        self.assert_finding(findings, "unsafe-tempfile")
        self.assert_no_finding(findings, "untyped-json-root")

    def test_rejects_from_json_loads_alias_without_object_root(self) -> None:
        findings = inspect_source(
            "from json import loads\n"
            "def load(text: str) -> str:\n"
            "    root = loads(text)\n"
            "    return str(root)\n",
            STDLIB,
        )

        self.assert_finding(findings, "untyped-json-root")

    def test_rejects_string_bare_container_annotations(self) -> None:
        findings = inspect_source(
            "def load() -> 'list[dict]':\n"
            "    return []\n",
            STDLIB,
        )

        self.assert_finding(findings, "bare-container-annotation")

    def test_allows_unrelated_any_and_cast_identifiers(self) -> None:
        findings = inspect_source(
            "class Holder:\n"
            "    Any = 'ordinary'\n"
            "    cast = 'ordinary'\n"
            "def load(raw: object) -> str:\n"
            "    Any = Holder.Any\n"
            "    cast = Holder.cast\n"
            "    return f'{Any}:{cast}:{raw}'\n",
            STDLIB,
        )

        self.assert_no_finding(findings, "dynamic-typing-escape")

    def test_rejects_a_type_ignore_comment_in_otherwise_valid_source(self) -> None:
        findings = inspect_source(
            "# type: ignore[unused-ignore]\n"
            "def load(raw: object) -> str:\n"
            "    return str(raw)\n",
            STDLIB,
        )

        self.assert_finding(findings, "dynamic-typing-escape")

    def test_rejects_nonstdlib_import(self) -> None:
        findings = inspect_source("import requests\ndef load() -> str:\n    return ''\n", STDLIB)

        self.assert_finding(findings, "non-stdlib-import")

    def test_rejects_shell_true(self) -> None:
        findings = inspect_source(
            "import subprocess\n"
            "def load() -> None:\n"
            "    subprocess.run('echo bad', shell=True)\n",
            STDLIB,
        )

        self.assert_finding(findings, "shell-true")

    def test_rejects_tempfile_mktemp(self) -> None:
        findings = inspect_source(
            "import tempfile\n"
            "def load() -> str:\n"
            "    return tempfile.mktemp()\n",
            STDLIB,
        )

        self.assert_finding(findings, "unsafe-tempfile")

    def test_rejects_untyped_json_root(self) -> None:
        findings = inspect_source(
            "import json\n"
            "def load(text: str) -> str:\n"
            "    value = json.loads(text)\n"
            "    return str(value)\n",
            STDLIB,
        )

        self.assert_finding(findings, "untyped-json-root")

    def test_accepts_object_typed_json_root_then_narrowing(self) -> None:
        findings = inspect_source(
            "import json\n"
            "def load(text: str) -> str:\n"
            "    value: object = json.loads(text)\n"
            "    if not isinstance(value, str):\n"
            "        raise ValueError('expected text')\n"
            "    return value\n",
            STDLIB,
        )

        self.assert_no_finding(findings, "untyped-json-root")

    def test_rejects_fixed_temp_path(self) -> None:
        findings = inspect_commands((command("python3 /tmp/helper.py input.json"),))

        self.assert_finding(findings, "unsafe-tempfile")

    def test_rejects_fixed_temp_path_even_when_mktemp_also_appears(self) -> None:
        findings = inspect_commands(
            (command("helper=$(mktemp); python3 /tmp/helper.py input.json"),)
        )

        self.assert_finding(findings, "unsafe-tempfile")

    def test_rejects_unquoted_heredoc_and_source_interpolation(self) -> None:
        findings = inspect_commands(
            (command("cat <<PY > \"$helper\"\nopen('$input').read()\nPY"),)
        )

        self.assert_finding(findings, "source-interpolation")

    def test_rejects_an_unquoted_heredoc_after_a_quoted_heredoc(self) -> None:
        findings = inspect_commands(
            (
                command(
                    "cat <<'PY' > good.py\nprint('safe')\nPY\n"
                    "cat <<PY > bad.py\nprint('$input')\nPY"
                ),
            )
        )

        self.assert_finding(findings, "source-interpolation")

    def test_allows_literal_dollar_in_single_quoted_python_c_source(self) -> None:
        findings = inspect_commands((command("python3 -c 'print(\"$\")'"),))

        self.assert_no_finding(findings, "source-interpolation")

    def test_accepts_quoted_heredoc_and_separately_passed_arguments(self) -> None:
        findings = inspect_commands(
            (
                command("helper=$(mktemp)"),
                command("cat <<'PY' > \"$helper\"\nprint('ready')\nPY"),
                command("python3 \"$helper\" \"$input\""),
                command("rm -f \"$helper\""),
            )
        )

        self.assertEqual(findings, ())

    def test_accepts_secure_temp_directory_forms(self) -> None:
        findings = inspect_commands(
            (command("tmp=$(mktemp -d)"), command("python3 helper.py \"$tmp/input.json\""))
        )

        self.assertEqual(findings, ())

    def test_accepts_tempfile_temporary_directory_source_and_command(self) -> None:
        source_findings = inspect_source(
            "import tempfile\n"
            "def load(text: str) -> str:\n"
            "    with tempfile.TemporaryDirectory() as directory:\n"
            "        return directory + text\n",
            STDLIB,
        )
        command_findings = inspect_commands((command("python3 helper.py input.json"),))

        self.assertEqual(source_findings, ())
        self.assertEqual(command_findings, ())

    def test_rejects_package_install_network_and_scaffolding(self) -> None:
        findings = inspect_commands(
            (
                command("python3 -m pip install requests"),
                command("curl https://example.invalid/tool.py"),
                command("python3 -m venv .venv"),
            )
        )

        self.assert_finding(findings, "package-install")
        self.assert_finding(findings, "network-access")
        self.assert_finding(findings, "project-scaffold")

    def test_rejects_working_directory_cache(self) -> None:
        findings = inspect_commands((command("mkdir .cache"),))

        self.assert_finding(findings, "working-cache")

    def test_probe_accepts_a_copied_mutated_input_and_concise_failure(self) -> None:
        result = evaluate_probe(
            (
                probe_event(
                    {
                        "copied_input": True,
                        "mutation": "boolean-attempt",
                        "same_helper": True,
                        "real_fixture_unchanged": True,
                        "input_hashes_verified": True,
                    },
                    {"exit_code": 2, "stderr": "attempt must be an integer"},
                ),
            )
        )

        self.assertTrue(result.observed)
        self.assertEqual(result.findings, ())

    def test_probe_rejects_traceback_only_failure(self) -> None:
        result = evaluate_probe(
            (
                probe_event(
                    {
                        "copied_input": True,
                        "mutation": "unknown-outcome",
                        "same_helper": True,
                        "real_fixture_unchanged": True,
                        "input_hashes_verified": True,
                    },
                    {"exit_code": 1, "stderr": "Traceback (most recent call last):"},
                ),
            )
        )

        self.assert_finding(result.findings, "probe-failure")

    def test_probe_rejects_boolean_exit_codes(self) -> None:
        result = evaluate_probe(
            (
                probe_event(
                    {
                        "copied_input": True,
                        "mutation": "unknown-outcome",
                        "same_helper": True,
                        "real_fixture_unchanged": True,
                        "input_hashes_verified": True,
                    },
                    {"exit_code": True, "stderr": "unknown outcome"},
                ),
            )
        )

        self.assert_finding(result.findings, "probe-failure")

    def test_probe_rejects_mutated_real_fixture(self) -> None:
        result = evaluate_probe(
            (
                probe_event(
                    {
                        "copied_input": False,
                        "mutation": "boolean-attempt",
                        "same_helper": True,
                        "real_fixture_unchanged": False,
                        "input_hashes_verified": True,
                    },
                    {"exit_code": 1, "stderr": "attempt must be an integer"},
                ),
            )
        )

        self.assert_finding(result.findings, "probe-failure")

    def test_probe_rejects_missing_input_hash_evidence(self) -> None:
        result = evaluate_probe(
            (
                probe_event(
                    {
                        "copied_input": True,
                        "mutation": "boolean-attempt",
                        "same_helper": True,
                        "real_fixture_unchanged": True,
                    },
                    {"exit_code": 1, "stderr": "attempt must be an integer"},
                ),
            )
        )

        self.assertFalse(result.observed)
        self.assertEqual(result.findings, ())

    def test_probe_reports_explicitly_false_hash_evidence_as_observed_failure(self) -> None:
        result = evaluate_probe(
            (
                probe_event(
                    {
                        "copied_input": True,
                        "mutation": "boolean-attempt",
                        "same_helper": True,
                        "real_fixture_unchanged": True,
                        "input_hashes_verified": False,
                    },
                    {"exit_code": 1, "stderr": "attempt must be an integer"},
                ),
            )
        )

        self.assertTrue(result.observed)
        self.assert_finding(result.findings, "missing-input-hash-evidence")

    def test_mechanical_failure_overrides_human_approval(self) -> None:
        verdict = evaluate_compliance(
            ComplianceInputs(
                source="def load() -> list[dict]: ...",
                commands=(),
                probe_events=(self._accepted_probe(),),
                baseline_manifest={"runs.json": "before"},
                post_run_manifest={"runs.json": "before"},
                proportionate_helper=True,
                proportionate_helper_notes="One focused helper.",
                sound_typed_narrowing=True,
                sound_typed_narrowing_notes="Validated before use.",
            )
        )

        self.assertEqual(verdict.state, VerdictState.FAIL)
        self.assertIn("bare-container-annotation", verdict.reasons)

    def test_missing_required_evidence_is_unobservable(self) -> None:
        verdict = evaluate_compliance(
            ComplianceInputs(
                source=None,
                commands=None,
                probe_events=None,
                baseline_manifest=None,
                post_run_manifest=None,
                proportionate_helper=None,
                proportionate_helper_notes=None,
                sound_typed_narrowing=None,
                sound_typed_narrowing_notes=None,
            )
        )

        self.assertEqual(verdict.state, VerdictState.UNOBSERVABLE)

    def test_absent_probe_evidence_is_unobservable_not_failure(self) -> None:
        verdict = evaluate_compliance(self._passing_inputs(probe_events=()))

        self.assertEqual(verdict.state, VerdictState.UNOBSERVABLE)
        self.assertNotIn("missing-probe-evidence", verdict.reasons)

    def test_absent_hash_evidence_is_unobservable_not_failure(self) -> None:
        missing_hash_probe = probe_event(
            {
                "copied_input": True,
                "mutation": "boolean-attempt",
                "same_helper": True,
                "real_fixture_unchanged": True,
            },
            {"exit_code": 1, "stderr": "attempt must be an integer"},
        )
        verdict = evaluate_compliance(
            self._passing_inputs(probe_events=(missing_hash_probe,))
        )

        self.assertEqual(verdict.state, VerdictState.UNOBSERVABLE)
        self.assertNotIn("missing-input-hash-evidence", verdict.reasons)

    def test_malformed_manifest_evidence_is_unobservable_not_an_exception(self) -> None:
        verdict = evaluate_compliance(
            self._passing_inputs(baseline_manifest=(), post_run_manifest=())
        )

        self.assertEqual(verdict.state, VerdictState.UNOBSERVABLE)

    def test_semantic_rejections_fail_with_notes(self) -> None:
        verdict = evaluate_compliance(
            self._passing_inputs(
                proportionate_helper=False,
                proportionate_helper_notes="A second verifier is unnecessary.",
                sound_typed_narrowing=False,
                sound_typed_narrowing_notes="Nested values are used before validation.",
            )
        )

        self.assertEqual(verdict.state, VerdictState.FAIL)
        self.assertIn("proportionate-helper", verdict.reasons)
        self.assertIn("sound-typed-narrowing", verdict.reasons)

    def test_semantic_boolean_without_notes_is_unobservable(self) -> None:
        verdict = evaluate_compliance(
            self._passing_inputs(proportionate_helper=True, proportionate_helper_notes="")
        )

        self.assertEqual(verdict.state, VerdictState.UNOBSERVABLE)

    def test_manifest_rejects_leftovers_and_changed_input_hashes(self) -> None:
        verdict = evaluate_compliance(
            self._passing_inputs(
                post_run_manifest={
                    "runs.json": "after",
                    "helper.py": "left-over",
                }
            )
        )

        self.assertEqual(verdict.state, VerdictState.FAIL)
        self.assertIn("workspace-leftover", verdict.reasons)
        self.assertIn("input-hash-changed", verdict.reasons)

    def test_manifest_accepts_unchanged_inputs_after_cleanup(self) -> None:
        verdict = evaluate_compliance(self._passing_inputs())

        self.assertEqual(verdict.state, VerdictState.PASS)

    def _accepted_probe(self) -> NormalizedEvent:
        return probe_event(
            {
                "copied_input": True,
                "mutation": "boolean-attempt",
                "same_helper": True,
                "real_fixture_unchanged": True,
                "input_hashes_verified": True,
            },
            {"exit_code": 1, "stderr": "attempt must be an integer"},
        )

    def _passing_inputs(self, **changes: object) -> ComplianceInputs:
        values: dict[str, object] = {
            "source": (
                "import json\n"
                "def load(text: str) -> str:\n"
                "    value: object = json.loads(text)\n"
                "    if not isinstance(value, str):\n"
                "        raise ValueError('expected text')\n"
                "    return value\n"
            ),
            "commands": (command("helper=$(mktemp)"), command("rm -f \"$helper\"")),
            "probe_events": (self._accepted_probe(),),
            "baseline_manifest": {"runs.json": "before"},
            "post_run_manifest": {"runs.json": "before"},
            "proportionate_helper": True,
            "proportionate_helper_notes": "One focused helper and spot-check.",
            "sound_typed_narrowing": True,
            "sound_typed_narrowing_notes": "The JSON root is object then narrowed.",
        }
        values.update(changes)
        # Tests deliberately inject malformed runtime evidence through this helper.
        return ComplianceInputs(**values)  # ty: ignore[invalid-argument-type]


if __name__ == "__main__":
    unittest.main()
