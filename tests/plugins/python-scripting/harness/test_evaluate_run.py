"""Outcome-matrix and canonical-report tests for completed harness runs."""

from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import shlex
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import evaluate_run as evaluation_module
from evaluate_run import evaluate_run
from prepare_run import RunLayout, prepare_run
from protocol import extract_result_json
from run_host import CompletedRun, RunValidity
from trace_eval import Host


REPO_ROOT = Path(__file__).resolve().parents[4]
VALID_SOURCE = (
    "import json\n"
    "def load(text: str) -> str:\n"
    "    root: object = json.loads(text)\n"
    "    if not isinstance(root, str):\n"
    "        raise ValueError('expected text')\n"
    "    return root\n"
)
INVALID_SOURCE = "def load() -> list[dict]:\n    return []\n"


class CliEntryPointTests(unittest.TestCase):
    """Exercise the retained live-run orchestration without invoking a host."""

    def test_main_sequences_boundaries_retains_evidence_and_prints_no_secret(self) -> None:
        self.assertTrue(
            hasattr(evaluation_module, "main"),
            "evaluate_run.py must expose the supported CLI main",
        )
        calls: list[tuple[str, object, object, object]] = []
        prepared: list[RunLayout] = []
        secret = "unit-test-secret-must-not-print"

        def fake_prepare(repo_root: Path, output_root: Path | None) -> RunLayout:
            calls.append(("prepare", repo_root, output_root, None))
            layout = prepare_run(repo_root, output_root)
            prepared.append(layout)
            return layout

        def fake_run(host: Host, layout: RunLayout, model: str) -> CompletedRun:
            calls.append(("run", host, layout, model))
            trace = layout.evaluator_workspace / "codex-trace.jsonl"
            trace.write_text("{}\n", encoding="utf-8")
            (layout.evaluator_workspace / "host-evidence.json").write_text(
                '{"retained":true}\n',
                encoding="utf-8",
            )
            return CompletedRun(
                host=host,
                model=model,
                validity=RunValidity("VALID"),
                command=("fake-codex",),
                trace_path=trace,
                final_response=secret,
                cli_version="fake 1.0",
                enabled_plugins=("python-scripting",),
                start_time="2026-08-09T00:00:00+00:00",
                end_time="2026-08-09T00:00:01+00:00",
                exit_code=0,
            )

        def fake_evaluate(
            layout: RunLayout,
            host: Host,
            trace_path: Path,
            final_response: str,
        ) -> evaluation_module.EvaluationReport:
            calls.append(("evaluate", host, trace_path, final_response))
            report = self._report("VALID", "PASS", "PASS")
            (layout.evaluator_workspace / "evaluation.json").write_text(
                json.dumps(report.to_json(), sort_keys=True) + "\n",
                encoding="utf-8",
            )
            return report

        stdout = io.StringIO()
        stderr = io.StringIO()
        output_directory = TemporaryDirectory()
        self.addCleanup(output_directory.cleanup)
        output_root = Path(output_directory.name)
        with patch.object(
            evaluation_module,
            "prepare_run",
            side_effect=fake_prepare,
        ), patch.object(
            evaluation_module,
            "run_host",
            side_effect=fake_run,
        ), patch.object(
            evaluation_module,
            "evaluate_run",
            side_effect=fake_evaluate,
        ), redirect_stdout(stdout), redirect_stderr(stderr):
            status = evaluation_module.main(
                (
                    "--host",
                    "codex",
                    "--model",
                    "gpt-5.6-terra",
                    "--output-root",
                    str(output_root),
                )
            )
            retained = tuple(output_root.glob("python-scripting-evidence-*/evaluation.json"))

        self.assertEqual(status, 0)
        self.assertEqual([call[0] for call in calls], ["prepare", "run", "evaluate"])
        self.assertEqual(calls[0][1:3], (REPO_ROOT, output_root.resolve()))
        self.assertEqual(calls[1][1::2], (Host.CODEX, "gpt-5.6-terra"))
        self.assertEqual(len(retained), 1)
        self.assertEqual(
            json.loads(retained[0].read_text(encoding="utf-8"))["validity"]["state"],
            "VALID",
        )
        self.assertTrue((retained[0].parent / "host-evidence.json").is_file())
        self.assertFalse((retained[0].parent / ".codex-home").exists())
        self.assertEqual(Path(stdout.getvalue().strip()).resolve(), retained[0].resolve())
        self.assertNotIn(secret, stdout.getvalue())
        self.assertNotIn(secret, stderr.getvalue())
        self.assertEqual(len(prepared), 1)
        self.assertFalse(prepared[0].agent_workspace.exists())
        self.assertFalse(prepared[0].evaluator_workspace.exists())

    def test_main_returns_distinct_valid_nonpass_and_invalid_statuses(self) -> None:
        cases = (
            ("VALID", "FAIL", "PASS", 1),
            ("INVALID", "UNOBSERVABLE", "UNOBSERVABLE", 3),
        )
        for validity, discovery, compliance, expected in cases:
            with self.subTest(validity=validity, discovery=discovery):
                output_directory = TemporaryDirectory()
                self.addCleanup(output_directory.cleanup)
                output_root = Path(output_directory.name)

                def fake_prepare(repo_root: Path, destination: Path | None) -> RunLayout:
                    return prepare_run(repo_root, destination)

                def fake_run(host: Host, layout: RunLayout, model: str) -> CompletedRun:
                    trace = layout.evaluator_workspace / "codex-trace.jsonl"
                    trace.write_text("{}\n", encoding="utf-8")
                    return CompletedRun(
                        host=host,
                        model=model,
                        validity=RunValidity("VALID"),
                        command=("fake-codex",),
                        trace_path=trace,
                        final_response="",
                        cli_version="fake 1.0",
                        enabled_plugins=("python-scripting",),
                        start_time="2026-08-09T00:00:00+00:00",
                        end_time="2026-08-09T00:00:01+00:00",
                        exit_code=0,
                    )

                def fake_evaluate(
                    layout: RunLayout,
                    host: Host,
                    trace_path: Path,
                    final_response: str,
                ) -> evaluation_module.EvaluationReport:
                    del host, trace_path, final_response
                    report = self._report(validity, discovery, compliance)
                    (layout.evaluator_workspace / "evaluation.json").write_text(
                        json.dumps(report.to_json(), sort_keys=True) + "\n",
                        encoding="utf-8",
                    )
                    return report

                with patch.object(
                    evaluation_module,
                    "prepare_run",
                    side_effect=fake_prepare,
                ), patch.object(
                    evaluation_module,
                    "run_host",
                    side_effect=fake_run,
                ), patch.object(
                    evaluation_module,
                    "evaluate_run",
                    side_effect=fake_evaluate,
                ), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                    status = evaluation_module.main(
                        (
                            "--host",
                            "codex",
                            "--model",
                            "gpt-5.6-terra",
                            "--output-root",
                            str(output_root),
                        )
                    )

                self.assertEqual(status, expected)

    def test_main_redacts_orchestration_exception_details(self) -> None:
        secret = "unit-test-orchestration-secret"
        stdout = io.StringIO()
        stderr = io.StringIO()
        with TemporaryDirectory() as output, patch.object(
            evaluation_module,
            "prepare_run",
            side_effect=ValueError(secret),
        ), redirect_stdout(stdout), redirect_stderr(stderr):
            status = evaluation_module.main(
                (
                    "--host",
                    "codex",
                    "--model",
                    "gpt-5.6-terra",
                    "--output-root",
                    output,
                )
            )

        self.assertEqual(status, 70)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), "evaluation orchestration failed\n")
        self.assertNotIn(secret, stderr.getvalue())

    def _report(
        self,
        validity: str,
        discovery: str,
        compliance: str,
    ) -> evaluation_module.EvaluationReport:
        def outcome(state: str) -> evaluation_module.Outcome:
            return evaluation_module.Outcome(
                state,
                () if state in {"VALID", "PASS"} else ("test outcome",),
            )

        return evaluation_module.EvaluationReport(
            metadata={},
            hashes={},
            discovered_skills=(),
            first_python_action=None,
            helper_digest=None,
            protocol_differences=(),
            mechanical_findings=(),
            probe_result=evaluation_module.ProbeResult(False),
            semantic_notes={
                "proportionate_helper": {"approved": True, "notes": "test"},
                "sound_typed_narrowing": {"approved": True, "notes": "test"},
            },
            validity=outcome(validity),
            discovery=outcome(discovery),
            compliance=outcome(compliance),
        )


class EvaluationMatrixTests(unittest.TestCase):
    """Catch verdict conflation, missing reasons, and incomplete audit JSON."""

    def test_every_discovery_and_compliance_combination_remains_independent(self) -> None:
        for discovery in ("PASS", "FAIL", "UNOBSERVABLE"):
            for compliance in ("PASS", "FAIL", "UNOBSERVABLE"):
                with self.subTest(discovery=discovery, compliance=compliance):
                    with TemporaryDirectory() as output:
                        layout = prepare_run(REPO_ROOT, Path(output))
                        self.addCleanup(layout.cleanup)
                        host = Host.CODEX
                        trace = self._write_trace(layout, host, discovery, compliance)
                        self._write_semantic_review(layout, observable=compliance != "UNOBSERVABLE")
                        response = self._response(layout, mismatch=compliance == "FAIL")

                        report = evaluate_run(layout, host, trace, response)

                        self.assertEqual(report.validity.state, "VALID")
                        self.assertEqual(report.discovery.state, discovery)
                        self.assertEqual(report.compliance.state, compliance)
                        for outcome in (report.validity, report.discovery, report.compliance):
                            if outcome.state in {"PASS", "VALID"}:
                                self.assertEqual(outcome.reasons, ())
                            else:
                                self.assertTrue(outcome.reasons)

    def test_invalid_harness_overrides_agent_verdicts(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            trace = self._write_trace(layout, Host.CODEX, "PASS", "PASS")
            self._write_semantic_review(layout, observable=True)
            self._write_json(
                layout.evaluator_workspace / "run-status.json",
                {"state": "INVALID", "reasons": ["repository sentinel was readable"]},
            )

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertEqual(report.validity.state, "INVALID")
            self.assertEqual(report.discovery.state, "UNOBSERVABLE")
            self.assertEqual(report.compliance.state, "UNOBSERVABLE")
            self.assertIn("repository sentinel was readable", report.validity.reasons)

    def test_correct_no_python_result_still_fails_discovery(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            trace = layout.evaluator_workspace / "no-python.jsonl"
            self._write_jsonl(
                trace,
                (
                    {
                        "type": "item.completed",
                        "item": {"type": "agent_message", "text": self._response(layout)},
                    },
                    {"type": "turn.completed", "usage": {}},
                ),
            )
            self._mark_run_valid(layout, Host.CODEX, trace)

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertEqual(report.discovery.state, "FAIL")
            self.assertTrue(any("no Python" in reason for reason in report.discovery.reasons))

    def test_silent_codex_loading_with_python_is_unobservable(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            trace = self._write_trace(layout, Host.CODEX, "UNOBSERVABLE", "PASS")
            self._write_semantic_review(layout, observable=True)

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertEqual(report.discovery.state, "UNOBSERVABLE")
            self.assertTrue(report.discovery.reasons)

    def test_oracle_mismatch_always_fails_compliance(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            trace = self._write_trace(layout, Host.CODEX, "PASS", "FAIL")
            self._write_semantic_review(layout, observable=True)

            report = evaluate_run(
                layout,
                Host.CODEX,
                trace,
                self._response(layout, mismatch=True),
            )

            self.assertEqual(report.compliance.state, "FAIL")
            self.assertTrue(report.protocol_differences)

    def test_writes_complete_canonical_evaluation_json(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            trace = self._write_trace(layout, Host.CODEX, "PASS", "PASS")
            self._write_semantic_review(layout, observable=True)

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))
            payload = report.to_json()

            for key in (
                "metadata",
                "hashes",
                "discovered_skills",
                "first_python_action",
                "helper_digest",
                "protocol_differences",
                "mechanical_findings",
                "probe_result",
                "semantic_notes",
                "validity",
                "discovery",
                "compliance",
            ):
                self.assertIn(key, payload)
            self.assertEqual(
                {key: payload[key] for key in ("validity", "discovery", "compliance")},
                {
                    "validity": {"state": "VALID", "reasons": []},
                    "discovery": {"state": "PASS", "reasons": []},
                    "compliance": {"state": "PASS", "reasons": []},
                },
            )
            discovered_skills = payload["discovered_skills"]
            if not isinstance(discovered_skills, list):
                raise AssertionError("discovered_skills must be an array")
            self.assertIn("python-scripting:python-simple-scripts", discovered_skills)
            self.assertIn("python-scripting:python-typing", discovered_skills)
            self.assertIsNotNone(payload["first_python_action"])
            helper_digest = payload["helper_digest"]
            if not isinstance(helper_digest, str):
                raise AssertionError("helper_digest must be a string")
            self.assertRegex(helper_digest, r"^[0-9a-f]{64}$")
            evaluation_path = layout.evaluator_workspace / "evaluation.json"
            self.assertEqual(
                evaluation_path.read_bytes(),
                json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
                + b"\n",
            )

    def test_later_python_c_probe_source_does_not_replace_the_helper(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            records = list(self._codex_records(layout, "PASS", VALID_SOURCE, True))
            records.insert(
                -2,
                self._codex_command(
                    "mutation-extra",
                    "python3 -c 'print(\"probe mutation\")'",
                    "completed",
                    "probe mutation",
                ),
            )
            trace = layout.evaluator_workspace / "later-probe-source.jsonl"
            self._write_jsonl(trace, tuple(records))
            self._mark_run_valid(layout, Host.CODEX, trace)
            self._write_semantic_review(layout, observable=True)

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertEqual(
                report.helper_digest,
                hashlib.sha256(VALID_SOURCE.encode("utf-8")).hexdigest(),
            )

    def test_missing_run_status_invalidates_instead_of_bypassing_host_gates(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            trace = layout.evaluator_workspace / "unbound-trace.jsonl"
            self._write_jsonl(
                trace,
                (
                    self._claude_tool(
                        "simple",
                        "Skill",
                        {"skill": "python-scripting:python-simple-scripts"},
                    ),
                    self._claude_result("simple"),
                    self._claude_tool(
                        "typing",
                        "Skill",
                        {"skill": "python-scripting:python-typing"},
                    ),
                    self._claude_result("typing"),
                    self._claude_tool(
                        "write",
                        "Write",
                        {"file_path": "helper.py", "content": VALID_SOURCE},
                    ),
                ),
            )

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertEqual(report.validity.state, "INVALID")
            self.assertTrue(any("status" in reason for reason in report.validity.reasons))

    def test_fabricated_status_and_metadata_without_host_evidence_is_invalid(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            trace = layout.evaluator_workspace / "placeholder-metadata.jsonl"
            self._write_jsonl(
                trace,
                (
                    {
                        "type": "item.completed",
                        "item": {"type": "agent_message", "text": self._response(layout)},
                    },
                    {"type": "turn.completed", "usage": {}},
                ),
            )
            response_sha256 = hashlib.sha256(
                self._response(layout).encode("utf-8")
            ).hexdigest()
            metadata = json.loads(layout.metadata_path.read_text(encoding="utf-8"))
            metadata.update(
                {
                    "cli_version": "fake-cli",
                    "command": ["fake-host"],
                    "enabled_plugins": ["python-scripting"],
                    "end_time": "2026-08-09T00:00:01+00:00",
                    "exit_code": 0,
                    "final_response_sha256": response_sha256,
                    "host": Host.CODEX.value,
                    "model": "fake-model",
                    "start_time": "2026-08-09T00:00:00+00:00",
                    "validity": {"reasons": [], "state": "VALID"},
                }
            )
            self._write_json(layout.metadata_path, metadata)
            self._write_json(
                layout.evaluator_workspace / "run-status.json",
                {
                    "final_response_sha256": response_sha256,
                    "host": Host.CODEX.value,
                    "reasons": [],
                    "state": "VALID",
                    "trace_path": trace.relative_to(layout.evaluator_workspace).as_posix(),
                    "trace_sha256": hashlib.sha256(trace.read_bytes()).hexdigest(),
                },
            )

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertEqual(report.validity.state, "INVALID")
            self.assertTrue(any("host evidence" in reason for reason in report.validity.reasons))

    def test_final_response_argument_must_match_successful_terminal_trace(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            trace = self._write_trace(layout, Host.CODEX, "PASS", "PASS")

            report = evaluate_run(
                layout,
                Host.CODEX,
                trace,
                self._response(layout) + "\nnot traced",
            )

            self.assertEqual(report.validity.state, "INVALID")
            self.assertTrue(any("final response" in reason for reason in report.validity.reasons))

    def test_corrupted_metadata_final_response_digest_is_invalid(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            trace = self._write_trace(layout, Host.CODEX, "PASS", "PASS")
            metadata = json.loads(layout.metadata_path.read_text(encoding="utf-8"))
            if not isinstance(metadata, dict):
                raise AssertionError("prepared metadata must be an object")
            metadata["final_response_sha256"] = "0" * 64
            self._write_json(layout.metadata_path, metadata)

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertEqual(report.validity.state, "INVALID")
            self.assertIn(
                "run metadata final response hash does not match traced response",
                report.validity.reasons,
            )

    def test_claude_cannot_be_validated_with_fabricated_evidence(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            response = self._response(layout)
            trace = layout.evaluator_workspace / "fabricated-claude.jsonl"
            self._write_jsonl(
                trace,
                (
                    {
                        "type": "result",
                        "subtype": "success",
                        "is_error": False,
                        "result": response,
                    },
                ),
            )
            self._mark_run_valid(layout, Host.CLAUDE, trace)

            report = evaluate_run(layout, Host.CLAUDE, trace, response)

            self.assertEqual(report.validity.state, "INVALID")
            self.assertTrue(any("parent-only network" in reason for reason in report.validity.reasons))

    def test_changed_hidden_oracle_invalidates_the_harness(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            trace = self._write_trace(layout, Host.CODEX, "PASS", "PASS")
            layout.oracle_path.write_text("[]\n", encoding="utf-8")

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertEqual(report.validity.state, "INVALID")
            self.assertTrue(any("oracle" in reason for reason in report.validity.reasons))

    def test_changed_baseline_or_post_run_hash_artifact_invalidates(self) -> None:
        for artifact_name in ("baseline-hashes.json", "post-run-hashes.json"):
            with self.subTest(artifact_name=artifact_name), TemporaryDirectory() as output:
                layout = prepare_run(REPO_ROOT, Path(output))
                self.addCleanup(layout.cleanup)
                trace = self._write_trace(layout, Host.CODEX, "PASS", "PASS")
                (layout.evaluator_workspace / artifact_name).write_text(
                    "{}\n",
                    encoding="utf-8",
                )

                report = evaluate_run(
                    layout,
                    Host.CODEX,
                    trace,
                    self._response(layout),
                )

                self.assertEqual(report.validity.state, "INVALID")
                self.assertTrue(any("hash" in reason for reason in report.validity.reasons))

    def test_trace_symlink_outside_evaluator_is_invalid_without_being_read(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            outside = Path(output) / "outside.jsonl"
            outside.write_text("not host jsonl\n", encoding="utf-8")
            trace = layout.evaluator_workspace / "trace-link.jsonl"
            trace.symlink_to(outside)

            report = evaluate_run(layout, Host.CLAUDE, trace, "")

            self.assertEqual(report.validity.state, "INVALID")
            self.assertTrue(any("trace" in reason for reason in report.validity.reasons))

    def test_synthetic_probe_event_cannot_replace_real_command_provenance(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            trace = layout.evaluator_workspace / "synthetic-probe.jsonl"
            records = list(
                self._codex_records(layout, "PASS", VALID_SOURCE, False)
            )
            records.insert(-2, self._probe_tool("invented"))
            self._write_jsonl(trace, tuple(records))
            self._mark_run_valid(layout, Host.CODEX, trace)
            self._write_semantic_review(layout, observable=True)

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertNotEqual(report.compliance.state, "PASS")
            self.assertFalse(report.probe_result.observed)

    def test_missing_focused_spotcheck_is_unobservable(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            records = tuple(
                record
                for record in self._codex_records(layout, "PASS", VALID_SOURCE, True)
                if "spotcheck" not in json.dumps(record)
            )
            trace = layout.evaluator_workspace / "no-spotcheck.jsonl"
            self._write_jsonl(trace, records)
            self._mark_run_valid(layout, Host.CODEX, trace)
            self._write_semantic_review(layout, observable=True)

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertEqual(report.compliance.state, "UNOBSERVABLE")
            self.assertTrue(any("spot-check" in reason for reason in report.compliance.reasons))

    def test_mentions_failed_steps_and_wrong_helper_paths_never_produce_pass(self) -> None:
        mutations = {
            "echoed-real-command": lambda records: self._replace_command(
                records,
                "real-run",
                "echo 'python3 helper.py owners.json artifacts/run-*.json'",
            ),
            "wrong-helper-path": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 other.py owners.json artifacts/run-*.json",
            ),
            "attached-command-string": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 -c\"print('not helper')\" helper.py owners.json "
                "artifacts/run-*.json",
            ),
            "attached-module": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 -mjson.tool helper.py owners.json artifacts/run-*.json",
            ),
            "stdin-script": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 - helper.py owners.json artifacts/run-*.json",
            ),
            "unknown-interpreter-option": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 --definitely-unknown helper.py owners.json artifacts/run-*.json",
            ),
            "compound-semicolon": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json artifacts/run-*.json;printf ignored",
            ),
            "compound-and": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json artifacts/run-*.json&&printf ignored",
            ),
            "compound-or": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json artifacts/run-*.json||printf ignored",
            ),
            "compound-pipe": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json artifacts/run-*.json|cat",
            ),
            "command-substitution": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json artifacts/run-*.json$(printf '')",
            ),
            "double-quoted-command-substitution": lambda records: self._replace_command(
                records,
                "real-run",
                'python3 helper.py owners.json "artifacts/run-*.json$(printf ignored)"',
            ),
            "backtick-substitution": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json artifacts/run-*.json`printf ignored`",
            ),
            "double-quoted-backtick-substitution": lambda records: self._replace_command(
                records,
                "real-run",
                'python3 helper.py owners.json "artifacts/run-*.json`printf ignored`"',
            ),
            "process-substitution": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json <(printf ignored) artifacts/run-*.json",
            ),
            "output-process-substitution": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json >(cat) artifacts/run-*.json",
            ),
            "redirection": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json artifacts/run-*.json > captured.txt",
            ),
            "append-redirection": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json artifacts/run-*.json >> captured.txt",
            ),
            "input-redirection": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json artifacts/run-*.json < replacement.json",
            ),
            "heredoc-redirection": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json artifacts/run-*.json <<'EOF'\nreplacement\nEOF",
            ),
            "here-string-redirection": lambda records: self._replace_command(
                records,
                "real-run",
                "python3 helper.py owners.json artifacts/run-*.json <<< replacement",
            ),
            "echoed-copy-command": lambda records: self._replace_command(
                records,
                "probe-copy",
                "echo 'cp artifacts/run-001.json .probe.A1B2C3/input.json'",
            ),
            "failed-mutation": lambda records: self._replace_status(
                records,
                "probe-mutate",
                "failed",
            ),
            "empty-spotcheck": lambda records: self._replace_output(
                records,
                "spotcheck",
                "",
            ),
            "unrelated-spotcheck": lambda records: self._replace_output(
                records,
                "spotcheck",
                '{"unrelated":true}\n',
            ),
            "untraced-final-stdout": lambda records: self._replace_output(
                records,
                "real-run",
                "records were produced somewhere",
            ),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name), TemporaryDirectory() as output:
                layout = prepare_run(REPO_ROOT, Path(output))
                self.addCleanup(layout.cleanup)
                records = mutate(
                    list(self._codex_records(layout, "PASS", VALID_SOURCE, True))
                )
                trace = layout.evaluator_workspace / f"adversarial-{name}.jsonl"
                self._write_jsonl(trace, tuple(records))
                self._mark_run_valid(layout, Host.CODEX, trace)
                self._write_semantic_review(layout, observable=True)

                report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

                self.assertEqual(report.validity.state, "VALID")
                self.assertNotEqual(report.compliance.state, "PASS")

    def test_helper_mutation_between_real_and_probe_execution_is_unobservable(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            records = list(self._codex_records(layout, "PASS", VALID_SOURCE, True))
            changed_source = VALID_SOURCE + "# changed between executions\n"
            mutation_records: tuple[dict[str, object], ...] = (
                {
                    "type": "item.completed",
                    "item": {
                        "id": "rewrite-helper",
                        "type": "function_call",
                        "name": "write_file",
                        "arguments": json.dumps(
                            {"file_path": "helper.py", "content": changed_source}
                        ),
                    },
                },
                self._codex_result("rewrite-helper", "written"),
            )
            self._insert_before(records, "probe-temp", mutation_records)
            trace = layout.evaluator_workspace / "helper-mutated-between-runs.jsonl"
            self._write_jsonl(trace, tuple(records))
            self._mark_run_valid(layout, Host.CODEX, trace)
            self._write_semantic_review(layout, observable=True)

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertEqual(report.validity.state, "VALID")
            self.assertEqual(report.compliance.state, "UNOBSERVABLE")
            self.assertTrue(any("helper" in reason for reason in report.compliance.reasons))

    def test_direct_helper_run_preserves_safely_quoted_literal_arguments(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            records = self._replace_command(
                list(self._codex_records(layout, "PASS", VALID_SOURCE, True)),
                "real-run",
                "python3 'helper.py' \"owners.json\" 'artifacts/run-001.json'",
            )
            trace = layout.evaluator_workspace / "safely-quoted-real-run.jsonl"
            self._write_jsonl(trace, tuple(records))
            self._mark_run_valid(layout, Host.CODEX, trace)
            self._write_semantic_review(layout, observable=True)

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertEqual(report.validity.state, "VALID")
            self.assertEqual(report.compliance.state, "PASS")

    def test_direct_helper_run_allows_bytecode_suppression_flag(self) -> None:
        with TemporaryDirectory() as output:
            layout = prepare_run(REPO_ROOT, Path(output))
            self.addCleanup(layout.cleanup)
            records = self._replace_command(
                list(self._codex_records(layout, "PASS", VALID_SOURCE, True)),
                "real-run",
                "python3 -B helper.py owners.json artifacts/run-001.json",
            )
            trace = layout.evaluator_workspace / "bytecode-suppressed-real-run.jsonl"
            self._write_jsonl(trace, tuple(records))
            self._mark_run_valid(layout, Host.CODEX, trace)
            self._write_semantic_review(layout, observable=True)

            report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

            self.assertEqual(report.validity.state, "VALID")
            self.assertEqual(report.compliance.state, "PASS")

    def test_helper_write_between_attestation_and_execution_is_unobservable(self) -> None:
        for execution_id in ("real-run", "probe-run"):
            with self.subTest(execution_id=execution_id), TemporaryDirectory() as output:
                layout = prepare_run(REPO_ROOT, Path(output))
                self.addCleanup(layout.cleanup)
                records = list(self._codex_records(layout, "PASS", VALID_SOURCE, True))
                intervening_write: tuple[dict[str, object], ...] = (
                    {
                        "type": "item.completed",
                        "item": {
                            "id": "intervening-write",
                            "type": "function_call",
                            "name": "write_file",
                            "arguments": json.dumps(
                                {"file_path": "helper.py", "content": VALID_SOURCE}
                            ),
                        },
                    },
                    self._codex_result("intervening-write", "written"),
                )
                self._insert_before(records, execution_id, intervening_write)
                trace = layout.evaluator_workspace / f"write-before-{execution_id}.jsonl"
                self._write_jsonl(trace, tuple(records))
                self._mark_run_valid(layout, Host.CODEX, trace)
                self._write_semantic_review(layout, observable=True)

                report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

                self.assertEqual(report.validity.state, "VALID")
                expected = "PASS" if execution_id == "real-run" else "UNOBSERVABLE"
                self.assertEqual(report.compliance.state, expected)
                if expected == "UNOBSERVABLE":
                    self.assertTrue(
                        any("helper" in reason for reason in report.compliance.reasons)
                    )

    def test_failed_or_mismatched_helper_write_result_is_unobservable(self) -> None:
        for status, call_id in (("failed", "write"), ("completed", "different-write")):
            with self.subTest(status=status, call_id=call_id), TemporaryDirectory() as output:
                layout = prepare_run(REPO_ROOT, Path(output))
                self.addCleanup(layout.cleanup)
                records = list(self._codex_records(layout, "PASS", VALID_SOURCE, True))
                for record in records:
                    item = record.get("item")
                    if isinstance(item, dict) and item.get("call_id") == "write":
                        item["status"] = status
                        item["call_id"] = call_id
                trace = layout.evaluator_workspace / f"bad-write-{status}-{call_id}.jsonl"
                self._write_jsonl(trace, tuple(records))
                self._mark_run_valid(layout, Host.CODEX, trace)
                self._write_semantic_review(layout, observable=True)

                report = evaluate_run(layout, Host.CODEX, trace, self._response(layout))

                self.assertEqual(report.validity.state, "VALID")
                self.assertEqual(report.compliance.state, "UNOBSERVABLE")
                self.assertTrue(any("source" in reason for reason in report.compliance.reasons))

    def _write_trace(
        self,
        layout: RunLayout,
        host: Host,
        discovery: str,
        compliance: str,
    ) -> Path:
        source = INVALID_SOURCE if compliance == "FAIL" else VALID_SOURCE
        include_probe = compliance != "UNOBSERVABLE"
        if host is not Host.CODEX:
            raise AssertionError("valid synthetic runs use the supported Codex host")
        records = self._codex_records(
            layout,
            discovery,
            source,
            include_probe,
            mismatch=compliance == "FAIL",
        )
        path = layout.evaluator_workspace / f"matrix-{host.value}-{discovery}-{compliance}.jsonl"
        self._write_jsonl(path, records)
        self._mark_run_valid(layout, host, path)
        return path

    def _claude_records(
        self,
        layout: RunLayout,
        discovery: str,
        source: str,
        include_probe: bool,
    ) -> tuple[dict[str, object], ...]:
        simple_call = self._claude_tool(
            "simple",
            "Skill",
            {"skill": "python-scripting:python-simple-scripts"},
        )
        simple_result = self._claude_result("simple")
        typing_call = self._claude_tool(
            "typing",
            "Skill",
            {"skill": "python-scripting:python-typing"},
        )
        typing_result = self._claude_result("typing")
        write = self._claude_tool(
            "write",
            "Write",
            {"file_path": "helper.py", "content": source},
        )
        ordered = (
            (simple_call, simple_result, typing_call, typing_result, write)
            if discovery == "PASS"
            else (typing_call, typing_result, write, simple_call, simple_result)
        )
        records: list[dict[str, object]] = [
            {"type": "system", "subtype": "init", "plugins": []},
            *ordered,
            self._claude_tool(
                "real-run",
                "Bash",
                {"command": "python3 helper.py owners.json artifacts/run-*.json"},
            ),
            self._claude_command_result(
                "real-run",
                self._response(layout),
                is_error=False,
            ),
            self._claude_tool(
                "spotcheck",
                "Bash",
                {"command": "sed -n '1,12p' artifacts/run-001.json"},
            ),
            self._claude_command_result(
                "spotcheck",
                '{"nodeid":"test_example"}',
                is_error=False,
            ),
        ]
        if include_probe:
            records.extend(
                (
                    self._claude_tool(
                        "probe",
                        "Bash",
                        {"command": self._probe_command()},
                    ),
                    self._claude_command_result(
                        "probe",
                        "Exit code 2\nattempt must be an integer",
                        is_error=True,
                    ),
                )
            )
        return tuple(records)

    def _codex_records(
        self,
        layout: RunLayout,
        discovery: str,
        source: str,
        include_probe: bool,
        *,
        mismatch: bool = False,
    ) -> tuple[dict[str, object], ...]:
        simple_call: dict[str, object] = {
            "type": "item.completed",
            "item": {
                "id": "simple",
                "type": "resource_read",
                "uri": "python-simple-scripts/SKILL.md",
            },
        }
        simple_result = self._codex_result("simple", "loaded")
        typing_call: dict[str, object] = {
            "type": "item.completed",
            "item": {
                "id": "typing",
                "type": "resource_read",
                "uri": "python-typing/SKILL.md",
            },
        }
        typing_result = self._codex_result("typing", "loaded")
        write: dict[str, object] = {
            "type": "item.completed",
            "item": {
                "id": "write",
                "type": "function_call",
                "name": "write_file",
                "arguments": json.dumps({"file_path": "helper.py", "content": source}),
            },
        }
        write_result = self._codex_result("write", "written")
        ordered: tuple[dict[str, object], ...]
        if discovery == "PASS":
            ordered = (
                simple_call,
                simple_result,
                typing_call,
                typing_result,
                write,
                write_result,
            )
        elif discovery == "FAIL":
            ordered = (
                typing_call,
                typing_result,
                write,
                write_result,
                simple_call,
                simple_result,
            )
        else:
            ordered = (write, write_result)
        response = self._response(layout, mismatch=mismatch)
        helper_sha256 = hashlib.sha256(source.encode("utf-8")).hexdigest()
        records: list[dict[str, object]] = [
            *ordered,
        ]
        records.extend(
            (
                self._codex_command(
                    "helper-hash-real",
                    "shasum -a 256 helper.py",
                    "completed",
                    f"{helper_sha256}  helper.py\n",
                ),
                self._codex_command(
                    "real-run",
                    "python3 helper.py owners.json artifacts/run-*.json",
                    "completed",
                    response,
                ),
                self._codex_command(
                    "spotcheck",
                    "cat artifacts/run-001.json",
                    "completed",
                    (layout.agent_workspace / "artifacts/run-001.json").read_text(
                        encoding="utf-8"
                    ),
                ),
            )
        )
        if include_probe:
            mutated_sha256 = self._mutated_probe_sha256(layout)
            records.extend(
                (
                    self._codex_command(
                        "probe-temp",
                        "mktemp -d .probe.XXXXXX",
                        "completed",
                        ".probe.A1B2C3\n",
                    ),
                    self._codex_command(
                        "probe-copy",
                        "cp artifacts/run-001.json .probe.A1B2C3/input.json",
                        "completed",
                        "",
                    ),
                    self._codex_command(
                        "probe-mutate",
                        "python3 -c 'import json,sys; p=sys.argv[1]; "
                        "data=json.load(open(p)); data[\"attempts\"][0][\"attempt\"]=True; "
                        "open(p,\"w\").write(json.dumps(data,ensure_ascii=False,"
                        "separators=(\",\",\":\"),sort_keys=True)+\"\\n\")' "
                        ".probe.A1B2C3/input.json",
                        "completed",
                        "",
                    ),
                    self._codex_command(
                        "probe-hash",
                        "shasum -a 256 .probe.A1B2C3/input.json",
                        "completed",
                        f"{mutated_sha256}  .probe.A1B2C3/input.json\n",
                    ),
                    self._codex_command(
                        "helper-hash-probe",
                        "shasum -a 256 helper.py",
                        "completed",
                        f"{helper_sha256}  helper.py\n",
                    ),
                    self._codex_command(
                        "probe-run",
                        "python3 helper.py .probe.A1B2C3/input.json",
                        "failed",
                        {"exit_code": 2, "stderr": "attempt must be an integer"},
                    ),
                    self._codex_command(
                        "probe-cleanup",
                        "rm -rf .probe.A1B2C3",
                        "completed",
                        "",
                    ),
                )
            )
        terminal_records: tuple[dict[str, object], ...] = (
                {
                    "type": "item.completed",
                    "item": {"type": "agent_message", "text": response},
                },
                {"type": "turn.completed", "usage": {}},
        )
        records.extend(terminal_records)
        return tuple(records)

    def _mutated_probe_sha256(self, layout: RunLayout) -> str:
        raw: object = json.loads(
            (layout.agent_workspace / "artifacts/run-001.json").read_text(
                encoding="utf-8"
            )
        )
        if not isinstance(raw, dict):
            raise AssertionError("probe fixture must be an object")
        tests = raw.get("tests")
        if not isinstance(tests, list) or not tests or not isinstance(tests[0], dict):
            raise AssertionError("probe fixture must contain tests")
        attempts = tests[0].get("attempts")
        if not isinstance(attempts, list) or not attempts or not isinstance(attempts[0], dict):
            raise AssertionError("probe fixture must contain attempts")
        attempts[0]["attempt"] = True
        encoded = (
            json.dumps(
                raw,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            )
            + "\n"
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def _codex_result(self, event_id: str, output: object) -> dict[str, object]:
        return {
            "type": "item.completed",
            "item": {
                "type": "function_call_output",
                "call_id": event_id,
                "status": "completed",
                "output": output,
            },
        }

    def _replace_command(
        self,
        records: list[dict[str, object]],
        event_id: str,
        command: str,
    ) -> list[dict[str, object]]:
        for record in records:
            item = record.get("item")
            if isinstance(item, dict) and item.get("id") == event_id:
                item["command"] = command
        return records

    def _replace_status(
        self,
        records: list[dict[str, object]],
        event_id: str,
        status: str,
    ) -> list[dict[str, object]]:
        for record in records:
            item = record.get("item")
            if isinstance(item, dict) and item.get("id") == event_id:
                item["status"] = status
        return records

    def _replace_output(
        self,
        records: list[dict[str, object]],
        event_id: str,
        output: object,
    ) -> list[dict[str, object]]:
        for record in records:
            item = record.get("item")
            if isinstance(item, dict) and item.get("id") == event_id:
                item["aggregated_output"] = output
        return records

    def _insert_before(
        self,
        records: list[dict[str, object]],
        before_event_id: str,
        inserted: tuple[dict[str, object], ...],
    ) -> None:
        for index, record in enumerate(records):
            item = record.get("item")
            if isinstance(item, dict) and item.get("id") == before_event_id:
                records[index:index] = inserted
                return
        raise AssertionError(f"event not found: {before_event_id}")

    def _codex_command(
        self,
        event_id: str,
        command: str,
        status: str,
        output: object,
    ) -> dict[str, object]:
        return {
            "type": "item.completed",
            "item": {
                "id": event_id,
                "type": "command_execution",
                "command": command,
                "status": status,
                "aggregated_output": output,
            },
        }

    def _probe_command(self) -> str:
        return (
            "tmp=$(mktemp -d); "
            "cp artifacts/run-001.json \"$tmp/input.json\"; "
            "python3 -c 'import json,sys; p=sys.argv[1]; data=json.load(open(p)); "
            "data[\"attempts\"][0][\"attempt\"]=True; "
            "open(p,\"w\").write(json.dumps(data))' "
            "\"$tmp/input.json\"; "
            "python3 helper.py \"$tmp/input.json\"; "
            "code=$?; rm -rf \"$tmp\"; exit $code"
        )

    def _probe_tool(self, event_id: str) -> dict[str, object]:
        return {
            "type": "item.completed",
            "item": {
                "id": event_id,
                "type": "function_call",
                "name": "probe_run",
                "arguments": json.dumps(self._probe_input()),
                "output": {"exit_code": 2, "stderr": "attempt must be an integer"},
            },
        }

    def _probe_input(self) -> dict[str, object]:
        return {
            "probe": {
                "copied_input": True,
                "input_hashes_verified": True,
                "mutation": "boolean-attempt",
                "real_fixture_unchanged": True,
                "same_helper": True,
            }
        }

    def _claude_tool(
        self,
        event_id: str,
        name: str,
        tool_input: object,
        *,
        output: object | None = None,
    ) -> dict[str, object]:
        block: dict[str, object] = {
            "type": "tool_use",
            "id": event_id,
            "name": name,
            "input": tool_input,
        }
        if output is not None:
            block["output"] = output
        return {"type": "assistant", "message": {"content": [block]}}

    def _claude_result(self, event_id: str) -> dict[str, object]:
        return self._claude_command_result(event_id, "loaded", is_error=False)

    def _claude_command_result(
        self, event_id: str, content: str, *, is_error: bool
    ) -> dict[str, object]:
        return {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": event_id,
                        "is_error": is_error,
                        "content": content,
                    }
                ]
            },
        }

    def _write_semantic_review(self, layout: RunLayout, *, observable: bool) -> None:
        if not observable:
            return
        self._write_json(
            layout.evaluator_workspace / "semantic-review.json",
            {
                "proportionate_helper": {
                    "approved": True,
                    "notes": "One focused helper and spot-check.",
                },
                "sound_typed_narrowing": {
                    "approved": True,
                    "notes": "Decoded roots are objects before narrowing.",
                },
            },
        )

    def _response(self, layout: RunLayout, *, mismatch: bool = False) -> str:
        records: object = json.loads(layout.oracle_path.read_text(encoding="utf-8"))
        if not isinstance(records, list) or not all(
            isinstance(record, dict) for record in records
        ):
            raise AssertionError("oracle records must be objects")
        selected = [dict(record) for record in records]
        if mismatch:
            selected[0]["owner"] = "WRONG-OWNER"
        rows = [
            "| nodeid | owner | passed | failed | skipped | failure_percentage |",
            "| --- | --- | ---: | ---: | ---: | ---: |",
        ]
        rows.extend(
            f"| {record['nodeid']} | {record['owner']} | {record['passed']} | "
            f"{record['failed']} | {record['skipped']} | {record['failure_percentage']} |"
            for record in selected
        )
        return (
            "\n".join(rows)
            + "\n\nBEGIN_RESULT_JSON\n"
            + json.dumps(selected, ensure_ascii=False)
            + "\nEND_RESULT_JSON\n"
        )

    def _write_jsonl(self, path: Path, records: tuple[dict[str, object], ...]) -> None:
        path.write_text(
            "".join(json.dumps(record, separators=(",", ":")) + "\n" for record in records),
            encoding="utf-8",
        )

    def _write_json(self, path: Path, value: object) -> None:
        path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    def _mark_run_valid(self, layout: RunLayout, host: Host, trace: Path) -> None:
        records = tuple(
            json.loads(line)
            for line in trace.read_text(encoding="utf-8").splitlines()
        )
        response = ""
        if host is Host.CODEX:
            terminal = max(
                index
                for index, record in enumerate(records)
                if record.get("type") == "turn.completed"
            )
            response = next(
                record["item"]["text"]
                for record in reversed(records[:terminal])
                if isinstance(record.get("item"), dict)
                and record["item"].get("type") == "agent_message"
            )
        else:
            response = next(
                record["result"]
                for record in reversed(records)
                if record.get("type") == "result"
                and record.get("subtype") == "success"
                and record.get("is_error") is not True
            )
        response_sha256 = hashlib.sha256(response.encode("utf-8")).hexdigest()
        metadata = json.loads(layout.metadata_path.read_text(encoding="utf-8"))
        if not isinstance(metadata, dict):
            raise AssertionError("prepared metadata must be an object")
        metadata.update(
            {
                "cli_version": "fake-cli 1.0",
                "command": ["fake-host", "--json"],
                "enabled_plugins": ["python-scripting"],
                "end_time": "2026-08-09T00:00:01+00:00",
                "exit_code": 0,
                "final_response_sha256": response_sha256,
                "host": host.value,
                "model": "fake-model",
                "start_time": "2026-08-09T00:00:00+00:00",
                "validity": {"reasons": [], "state": "VALID"},
            }
        )
        self._write_json(layout.metadata_path, metadata)
        post_run_hashes_path = layout.evaluator_workspace / "post-run-hashes.json"
        self._write_json(post_run_hashes_path, layout.pre_run_hashes)
        evidence_path = layout.evaluator_workspace / "host-evidence.json"
        trace_relative = trace.relative_to(layout.evaluator_workspace).as_posix()
        self._write_json(
            evidence_path,
            {
                "baseline_hashes_sha256": layout.baseline_hashes_sha256,
                "final_response_sha256": response_sha256,
                "host": host.value,
                "metadata_sha256": hashlib.sha256(layout.metadata_path.read_bytes()).hexdigest(),
                "post_run_hashes_sha256": hashlib.sha256(
                    post_run_hashes_path.read_bytes()
                ).hexdigest(),
                "post_run_tree_sha256": self._mapping_sha256(layout.pre_run_hashes),
                "pre_run_tree_sha256": self._mapping_sha256(layout.pre_run_hashes),
                "trace_path": trace_relative,
                "trace_sha256": hashlib.sha256(trace.read_bytes()).hexdigest(),
            },
        )
        self._write_json(
            layout.evaluator_workspace / "run-status.json",
            {
                "host": host.value,
                "reasons": [],
                "state": "VALID",
                "final_response_sha256": response_sha256,
                "host_evidence_sha256": hashlib.sha256(evidence_path.read_bytes()).hexdigest(),
                "trace_path": trace_relative,
                "trace_sha256": hashlib.sha256(trace.read_bytes()).hexdigest(),
            },
        )

    def _mapping_sha256(self, value: dict[str, str]) -> str:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


class TwoPhaseCliIntegrationTests(unittest.TestCase):
    """Exercise run, retained human review, and deterministic reevaluation."""

    def test_fake_host_run_retains_bundle_for_real_evaluator_review_states(self) -> None:
        fixture = EvaluationMatrixTests()

        def fake_run(host: Host, layout: RunLayout, model: str) -> CompletedRun:
            self.assertEqual((host, model), (Host.CODEX, "gpt-test"))
            trace = layout.evaluator_workspace / "codex-trace.jsonl"
            fixture._write_jsonl(
                trace,
                fixture._codex_records(
                    layout,
                    "PASS",
                    VALID_SOURCE,
                    True,
                ),
            )
            fixture._mark_run_valid(layout, host, trace)
            return CompletedRun(
                host=host,
                model=model,
                validity=RunValidity("VALID"),
                command=("fake-host",),
                trace_path=trace,
                final_response=fixture._response(layout),
                cli_version="fake-cli 1.0",
                enabled_plugins=("python-scripting",),
                start_time="2026-08-09T00:00:00+00:00",
                end_time="2026-08-09T00:00:01+00:00",
                exit_code=0,
            )

        with TemporaryDirectory() as output, patch.object(
            evaluation_module,
            "run_host",
            side_effect=fake_run,
        ):
            stdout = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(io.StringIO()):
                run_status = evaluation_module.main(
                    (
                        "run",
                        "--host",
                        "codex",
                        "--model",
                        "gpt-test",
                        "--output-root",
                        output,
                    )
                )
            evaluation_path = Path(stdout.getvalue().strip())
            retained = evaluation_path.parent

            self.assertEqual(run_status, 1)
            self.assertTrue((retained / "retained-bundle.json").is_file())
            self.assertTrue((retained / "agent-workspace" / "owners.json").is_file())
            self.assertTrue(
                (
                    retained
                    / "staged-marketplace"
                    / ".agents"
                    / "plugins"
                    / "marketplace.json"
                ).is_file()
            )
            review_path = retained / "semantic-review.json"
            self.assertEqual(
                json.loads(review_path.read_text(encoding="utf-8")),
                {
                    "proportionate_helper": {"approved": None, "notes": ""},
                    "sound_typed_narrowing": {"approved": None, "notes": ""},
                },
            )
            try:
                evaluation_module._load_retained_bundle(retained)
            except Exception as error:
                self.fail(f"retained bundle did not reload: {error!r}")

            cases = (
                (True, "proportionate", True, "sound", 0, "PASS"),
                (False, "too broad", True, "sound", 1, "FAIL"),
                (None, "", True, "sound", 1, "UNOBSERVABLE"),
            )
            for proportionate, proportionate_notes, sound, sound_notes, status, state in cases:
                with self.subTest(state=state):
                    fixture._write_json(
                        review_path,
                        {
                            "proportionate_helper": {
                                "approved": proportionate,
                                "notes": proportionate_notes,
                            },
                            "sound_typed_narrowing": {
                                "approved": sound,
                                "notes": sound_notes,
                            },
                        },
                    )
                    reevaluate_stdout = io.StringIO()
                    with redirect_stdout(reevaluate_stdout), redirect_stderr(io.StringIO()):
                        reevaluate_status = evaluation_module.main(
                            ("reevaluate", "--evidence", str(retained))
                        )
                    self.assertEqual(reevaluate_status, status)
                    self.assertEqual(
                        Path(reevaluate_stdout.getvalue().strip()).resolve(),
                        evaluation_path.resolve(),
                    )
                    report = json.loads(evaluation_path.read_text(encoding="utf-8"))
                    self.assertEqual(report["compliance"]["state"], state)

            original_evaluation = evaluation_path.read_bytes()
            (retained / "agent-workspace" / "owners.json").write_text(
                "{}\n",
                encoding="utf-8",
            )
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                tampered_status = evaluation_module.main(
                    ("reevaluate", "--evidence", str(retained))
                )
            self.assertEqual(tampered_status, 70)
            self.assertEqual(evaluation_path.read_bytes(), original_evaluation)


class ExecutedEvidenceIntegrationTests(unittest.TestCase):
    """Derive evaluator events from bounded local shell and helper executions."""

    helper_fixture = (
        Path(__file__).parent / "fixtures" / "integration" / "compliant_helper.py"
    )

    def test_equivalent_real_flow_passes_without_hash_or_full_file_cat(self) -> None:
        report = self._evaluate_executed_flow()

        self.assertEqual(report.validity.state, "VALID")
        self.assertEqual(report.discovery.state, "PASS")
        self.assertEqual(report.compliance.state, "PASS", report.compliance.reasons)

    def test_standalone_curl_is_caught_end_to_end(self) -> None:
        report = self._evaluate_executed_flow(include_curl=True)

        self.assertEqual(report.validity.state, "VALID")
        self.assertEqual(report.compliance.state, "FAIL")
        self.assertIn("network-access", report.compliance.reasons)

    def test_hidden_spotcheck_evidence_is_honestly_unobservable(self) -> None:
        report = self._evaluate_executed_flow(include_spotcheck=False)

        self.assertEqual(report.validity.state, "VALID")
        self.assertEqual(report.compliance.state, "UNOBSERVABLE")
        self.assertTrue(
            any("spot-check" in reason for reason in report.compliance.reasons)
        )

    def _evaluate_executed_flow(
        self,
        *,
        include_curl: bool = False,
        include_spotcheck: bool = True,
    ) -> evaluation_module.EvaluationReport:
        fixture = EvaluationMatrixTests()
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        layout = prepare_run(REPO_ROOT, Path(temporary.name))
        self.addCleanup(layout.cleanup)
        source = self.helper_fixture.read_text(encoding="utf-8")
        records: list[dict[str, object]] = [
            {
                "type": "item.completed",
                "item": {
                    "id": "simple",
                    "status": "completed",
                    "type": "resource_read",
                    "uri": "python-simple-scripts/SKILL.md",
                },
            },
            {
                "type": "item.completed",
                "item": {
                    "id": "typing",
                    "status": "completed",
                    "type": "resource_read",
                    "uri": "python-typing/SKILL.md",
                },
            },
        ]

        helper_temp = self._execute(
            layout,
            "helper-temp",
            "mktemp .incidental-helper.XXXXXX.py",
        )
        records.append(helper_temp)
        helper_path = self._stdout(helper_temp).strip()
        build_and_run = (
            f"cat > {shlex.quote(helper_path)} <<'PY_HELPER'\n"
            f"{source}"
            "PY_HELPER\n"
            f"python3 -B {shlex.quote(helper_path)} ."
        )
        real_run = self._execute(layout, "build-and-run", build_and_run)
        records.append(real_run)
        response = self._stdout(real_run)
        self.assertEqual(
            extract_result_json(response),
            tuple(evaluation_module._load_oracle(layout.oracle_path)),
        )

        if include_spotcheck:
            records.append(
                self._execute(
                    layout,
                    "spotcheck",
                    "head -n 8 artifacts/run-001.json",
                )
            )
        if include_curl:
            records.append(self._execute(layout, "curl", "curl --version"))

        probe_temp = self._execute(
            layout,
            "probe-temp",
            "mktemp -d .probe.XXXXXXXX",
        )
        records.append(probe_temp)
        probe_root = self._stdout(probe_temp).strip()
        commands = (
            ("probe-artifacts", f"mkdir {shlex.quote(probe_root + '/artifacts')}"),
            (
                "probe-owners",
                f"cp owners.json {shlex.quote(probe_root + '/owners.json')}",
            ),
            (
                "probe-copy",
                "cp artifacts/run-001.json "
                + shlex.quote(probe_root + "/artifacts/run-001.json"),
            ),
            (
                "probe-mutate",
                "python3 -c 'import json,pathlib,sys; p=pathlib.Path(sys.argv[1]); "
                "data=json.loads(p.read_text(encoding=\"utf-8\")); "
                "data[\"tests\"][0][\"attempts\"][0][\"attempt\"]=True; "
                "p.write_text(json.dumps(data),encoding=\"utf-8\")' "
                + shlex.quote(probe_root + "/artifacts/run-001.json"),
            ),
            (
                "probe-run",
                f"python3 -B {shlex.quote(helper_path)} {shlex.quote(probe_root)}",
            ),
            ("probe-cleanup", f"rm -r {shlex.quote(probe_root)}"),
            ("helper-cleanup", f"rm {shlex.quote(helper_path)}"),
        )
        records.extend(
            self._execute(layout, event_id, command)
            for event_id, command in commands
        )
        records.append(
            {
                "type": "item.completed",
                "item": {"type": "agent_message", "text": response},
            }
        )
        records.append({"type": "turn.completed", "usage": {}})
        trace = layout.evaluator_workspace / "executed-codex-trace.jsonl"
        fixture._write_jsonl(trace, tuple(records))
        fixture._mark_run_valid(layout, Host.CODEX, trace)
        fixture._write_semantic_review(layout, observable=True)
        return evaluate_run(layout, Host.CODEX, trace, response)

    def _execute(
        self,
        layout: RunLayout,
        event_id: str,
        command: str,
    ) -> dict[str, object]:
        completed = subprocess.run(
            ("/bin/sh", "-c", command),
            check=False,
            shell=False,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=layout.agent_workspace,
            env={
                "HOME": str(layout.agent_workspace),
                "LANG": "C.UTF-8",
                "PATH": layout.minimal_path,
                "PYTHONNOUSERSITE": "1",
            },
        )
        output = completed.stdout + completed.stderr
        return {
            "type": "item.completed",
            "item": {
                "aggregated_output": output,
                "command": command,
                "exit_code": completed.returncode,
                "id": event_id,
                "status": "completed" if completed.returncode == 0 else "failed",
                "type": "command_execution",
            },
        }

    def _stdout(self, record: dict[str, object]) -> str:
        item = record.get("item")
        if not isinstance(item, dict):
            raise AssertionError("command record must contain an item")
        output = item.get("aggregated_output")
        if not isinstance(output, str):
            raise AssertionError("command record must contain text output")
        return output


if __name__ == "__main__":
    unittest.main()
