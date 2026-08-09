"""Compose validity, discovery, and compliance into canonical evaluation JSON."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import sys
from tempfile import mkdtemp
from typing import Callable, Mapping, Sequence, TypedDict

from compliance import (
    ComplianceInputs,
    Finding,
    ProbeResult,
    evaluate_compliance,
    evaluate_probe,
    inspect_commands,
    inspect_source,
)
from generate_fixture import FileDigest, FixtureManifest
from oracle import ReportRecord
from prepare_run import RunLayout, prepare_run
from protocol import ProtocolError, compare_results, extract_result_json
from run_host import (
    _claude_final_response,
    _codex_final_response,
    _hash_regular_files,
    _mapping_sha256,
    _read_beneath,
    _read_jsonl,
    _read_regular_file,
    _regular_files,
    run_host,
)
from trace_eval import (
    Host,
    CapturedSource,
    NormalizedEvent,
    TraceAnalysis,
    TraceFormatError,
    VerdictState,
    analyze_trace,
)


_SIMPLE_SKILL = "python-scripting:python-simple-scripts"
_TYPING_SKILL = "python-scripting:python-typing"
_UNEXPECTED_SKILLS = frozenset(
    {
        "python-scripting:python-quality-tools",
        "python-scripting:macos-python-scripting",
    }
)


class ReviewValue(TypedDict):
    approved: bool | None
    notes: str | None


class SemanticNotes(TypedDict):
    proportionate_helper: ReviewValue
    sound_typed_narrowing: ReviewValue


@dataclass(frozen=True)
class _CollectedEvidence:
    """Evidence reconstructed from real shell calls and matching host results."""

    probe_events: tuple[NormalizedEvent, ...]
    hidden_reasons: tuple[str, ...]


@dataclass(frozen=True)
class Outcome:
    """A canonical outcome whose non-pass states always explain themselves."""

    state: str
    reasons: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        allowed = {"VALID", "INVALID", "PASS", "FAIL", "UNOBSERVABLE"}
        if self.state not in allowed:
            raise ValueError(f"unknown outcome state: {self.state}")
        if self.state in {"VALID", "PASS"} and self.reasons:
            raise ValueError(f"{self.state} outcomes cannot have reasons")
        if self.state in {"INVALID", "FAIL", "UNOBSERVABLE"} and not self.reasons:
            raise ValueError(f"{self.state} outcomes require reasons")

    def to_json(self) -> dict[str, object]:
        return {"state": self.state, "reasons": list(self.reasons)}


@dataclass(frozen=True)
class EvaluationReport:
    """All evidence needed to audit the three independent outcomes."""

    metadata: dict[str, object]
    hashes: dict[str, object]
    discovered_skills: tuple[str, ...]
    first_python_action: dict[str, object] | None
    helper_digest: str | None
    protocol_differences: tuple[str, ...]
    mechanical_findings: tuple[Finding, ...]
    probe_result: ProbeResult
    semantic_notes: SemanticNotes
    validity: Outcome
    discovery: Outcome
    compliance: Outcome

    def to_json(self) -> dict[str, object]:
        return {
            "compliance": self.compliance.to_json(),
            "discovered_skills": list(self.discovered_skills),
            "discovery": self.discovery.to_json(),
            "first_python_action": self.first_python_action,
            "hashes": self.hashes,
            "helper_digest": self.helper_digest,
            "mechanical_findings": [asdict(finding) for finding in self.mechanical_findings],
            "metadata": self.metadata,
            "probe_result": {
                "findings": [asdict(finding) for finding in self.probe_result.findings],
                "observed": self.probe_result.observed,
            },
            "protocol_differences": list(self.protocol_differences),
            "semantic_notes": self.semantic_notes,
            "validity": self.validity.to_json(),
        }


def evaluate_run(
    layout: RunLayout,
    host: Host,
    trace_path: Path,
    final_response: str,
) -> EvaluationReport:
    """Evaluate one isolated trace and write its canonical audit report."""
    metadata = _metadata(layout, host)
    try:
        workspace_files, workspace_reasons = _regular_files(layout.agent_workspace)
        post_run_hashes = _hash_regular_files(layout.agent_workspace, workspace_files)
    except (OSError, ValueError) as error:
        workspace_reasons = (f"agent workspace evidence scan failed: {error}",)
        post_run_hashes = {}
    hashes: dict[str, object] = {
        "fixture_manifest_sha256": layout.manifest_sha256,
        "plugin_sha256": layout.plugin_sha256,
        "pre_run_workspace": dict(sorted(layout.pre_run_hashes.items())),
        "post_run_workspace": dict(sorted(post_run_hashes.items())),
    }
    validity_reasons = list(
        _validity_reasons(
            layout,
            host,
            trace_path,
            final_response,
            post_run_hashes,
            workspace_reasons,
        )
    )
    analysis: TraceAnalysis | None = None
    if not validity_reasons:
        try:
            analysis = analyze_trace(host, trace_path)
        except (OSError, TraceFormatError, ValueError) as error:
            validity_reasons.append(f"trace could not be normalized: {error}")

    if validity_reasons or analysis is None:
        report = EvaluationReport(
            metadata=metadata,
            hashes=hashes,
            discovered_skills=(),
            first_python_action=None,
            helper_digest=None,
            protocol_differences=(),
            mechanical_findings=(),
            probe_result=ProbeResult(False),
            semantic_notes=_empty_semantic_review(),
            validity=Outcome("INVALID", tuple(validity_reasons or ("trace analysis unavailable",))),
            discovery=Outcome("UNOBSERVABLE", ("harness run is invalid",)),
            compliance=Outcome("UNOBSERVABLE", ("harness run is invalid",)),
        )
        _write_report(layout, report)
        return report

    discovered_skills = _discovered_skills(analysis)
    first_action = (
        _event_json(analysis.python_actions[0]) if analysis.python_actions else None
    )
    source = _helper_source(analysis)
    helper_digest = (
        hashlib.sha256(source.encode("utf-8")).hexdigest()
        if source is not None
        else None
    )
    protocol_differences = _protocol_differences(layout, final_response)
    semantic = _semantic_review(layout)
    collected = _collect_execution_evidence(
        analysis,
        final_response,
        layout.pre_run_hashes == post_run_hashes,
        layout.agent_workspace,
        helper_digest,
    )
    probe_result = evaluate_probe(collected.probe_events)
    mechanical = list(_mechanical_findings(analysis, source, probe_result))
    routing_findings = _routing_findings(host, analysis, discovered_skills)
    mechanical.extend(routing_findings)
    mechanical.extend(
        Finding("oracle-mismatch", difference) for difference in protocol_differences
    )

    compliance_verdict = evaluate_compliance(
        ComplianceInputs(
            source=source if analysis.source_observable else None,
            commands=analysis.commands,
            probe_events=collected.probe_events,
            baseline_manifest=layout.pre_run_hashes,
            post_run_manifest=post_run_hashes,
            proportionate_helper=semantic["proportionate_helper"]["approved"],
            proportionate_helper_notes=semantic["proportionate_helper"]["notes"],
            sound_typed_narrowing=semantic["sound_typed_narrowing"]["approved"],
            sound_typed_narrowing_notes=semantic["sound_typed_narrowing"]["notes"],
        )
    )
    compliance = _compose_compliance(
        compliance_verdict.state,
        (*compliance_verdict.reasons, *collected.hidden_reasons),
        mechanical,
    )
    discovery = Outcome(
        analysis.discovery.state.value,
        analysis.discovery.reasons,
    )
    report = EvaluationReport(
        metadata=metadata,
        hashes=hashes,
        discovered_skills=discovered_skills,
        first_python_action=first_action,
        helper_digest=helper_digest,
        protocol_differences=protocol_differences,
        mechanical_findings=tuple(mechanical),
        probe_result=probe_result,
        semantic_notes=semantic,
        validity=Outcome("VALID"),
        discovery=discovery,
        compliance=compliance,
    )
    _write_report(layout, report)
    return report


def _validity_reasons(
    layout: RunLayout,
    host: Host,
    trace_path: Path,
    final_response: str,
    post_run_hashes: Mapping[str, str],
    workspace_reasons: Sequence[str],
) -> tuple[str, ...]:
    reasons = list(workspace_reasons)
    if host is Host.CLAUDE:
        reasons.append(
            "Claude parent-only network isolation is unsupported without "
            "a separately sandboxed shell or network broker"
        )
    resolved_trace: Path | None = None
    traced_response: str | None = None
    try:
        trace_mode = trace_path.lstat().st_mode
    except OSError as error:
        reasons.append(f"trace is unavailable: {error}")
    else:
        if not stat.S_ISREG(trace_mode):
            reasons.append("trace is not a regular evaluator file")
        else:
            try:
                candidate = trace_path.resolve(strict=True)
            except OSError as error:
                reasons.append(f"trace is unavailable: {error}")
            else:
                if not candidate.is_relative_to(layout.evaluator_workspace.resolve()):
                    reasons.append("trace is outside evaluator storage")
                else:
                    resolved_trace = candidate
                    try:
                        records = _read_jsonl(candidate)
                        traced_response = (
                            _codex_final_response(records)
                            if host is Host.CODEX
                            else _claude_final_response(records)
                        )
                    except (OSError, ValueError) as error:
                        reasons.append(f"successful terminal response is unavailable: {error}")
                    else:
                        if traced_response != final_response:
                            reasons.append(
                                "final response argument does not match successful terminal trace"
                            )

    status_path = layout.evaluator_workspace / "run-status.json"
    if not status_path.exists():
        reasons.append("run status is missing")
    else:
        try:
            status: object = json.loads(status_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            reasons.append(f"run status is malformed: {error}")
        else:
            if not isinstance(status, dict) or status.get("state") not in {"VALID", "INVALID"}:
                reasons.append("run status has an invalid shape")
            elif status["state"] == "INVALID":
                raw_reasons = status.get("reasons")
                if isinstance(raw_reasons, list) and all(
                    isinstance(reason, str) and reason for reason in raw_reasons
                ):
                    reasons.extend(raw_reasons)
                else:
                    reasons.append("host marked run invalid without usable reasons")
            elif resolved_trace is not None:
                _validate_status_binding(
                    status,
                    layout,
                    host,
                    resolved_trace,
                    final_response,
                    reasons,
                )
                reasons.extend(_metadata_reasons(layout, host, traced_response))
                reasons.extend(
                    _host_evidence_reasons(
                        layout,
                        host,
                        resolved_trace,
                        final_response,
                        post_run_hashes,
                        status,
                    )
                )
    try:
        plugin_hash = _current_plugin_hash(layout.staged_plugin)
    except (OSError, ValueError) as error:
        reasons.append(f"staged plugin evidence is unavailable: {error}")
    else:
        if plugin_hash != layout.plugin_sha256:
            reasons.append("staged plugin hash changed")
    for path, expected, label in (
        (layout.baseline_hashes_path, layout.baseline_hashes_sha256, "baseline hashes"),
        (layout.fixture_manifest_path, layout.manifest_sha256, "fixture manifest"),
        (layout.oracle_path, layout.oracle_sha256, "hidden oracle"),
    ):
        try:
            current = _sha256(path)
        except OSError as error:
            reasons.append(f"{label} evidence is unavailable: {error}")
        else:
            if current != expected:
                reasons.append(f"{label} hash changed")
    return tuple(reasons)


def _validate_status_binding(
    status: Mapping[str, object],
    layout: RunLayout,
    host: Host,
    trace_path: Path,
    final_response: str,
    reasons: list[str],
) -> None:
    expected_relative = trace_path.relative_to(
        layout.evaluator_workspace.resolve()
    ).as_posix()
    if status.get("host") != host.value:
        reasons.append("run status host does not match evaluation host")
    if status.get("trace_path") != expected_relative:
        reasons.append("run status trace path does not match evaluation trace")
    if status.get("trace_sha256") != _sha256(trace_path):
        reasons.append("run status trace hash does not match evaluation trace")
    if status.get("final_response_sha256") != _text_sha256(final_response):
        reasons.append("run status final response hash does not match evaluation response")
    raw_reasons = status.get("reasons")
    if raw_reasons != []:
        reasons.append("valid run status must have no reasons")


def _metadata_reasons(
    layout: RunLayout,
    host: Host,
    traced_response: str | None,
) -> tuple[str, ...]:
    try:
        raw: object = json.loads(layout.metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return (f"run metadata is malformed: {error}",)
    if not isinstance(raw, dict):
        return ("run metadata is not an object",)

    reasons: list[str] = []
    if raw.get("host") != host.value:
        reasons.append("run metadata host does not match evaluation host")
    for field in ("model", "cli_version", "start_time", "end_time"):
        if not isinstance(raw.get(field), str) or not raw[field]:
            reasons.append(f"run metadata {field} is missing")
    command = raw.get("command")
    if not isinstance(command, list) or not command or not all(
        isinstance(part, str) and part for part in command
    ):
        reasons.append("run metadata command is missing")
    if raw.get("exit_code") != 0:
        reasons.append("run metadata does not record a successful host exit")
    validity = raw.get("validity")
    if validity != {"state": "VALID", "reasons": []}:
        reasons.append("run metadata validity does not match valid run status")
    plugins = raw.get("enabled_plugins")
    if host is Host.CODEX and plugins != ["python-scripting"]:
        reasons.append("run metadata plugin inventory is not exactly python-scripting")
    final_response_sha256 = raw.get("final_response_sha256")
    if not isinstance(final_response_sha256, str):
        reasons.append("run metadata final response hash is missing")
    elif traced_response is None:
        reasons.append("run metadata final response hash cannot be bound to a traced response")
    elif final_response_sha256 != _text_sha256(traced_response):
        reasons.append("run metadata final response hash does not match traced response")
    return tuple(reasons)


def _host_evidence_reasons(
    layout: RunLayout,
    host: Host,
    trace_path: Path,
    final_response: str,
    post_run_hashes: Mapping[str, str],
    status: Mapping[str, object],
) -> tuple[str, ...]:
    evidence_path = layout.evaluator_workspace / "host-evidence.json"
    try:
        mode = evidence_path.lstat().st_mode
    except OSError as error:
        return (f"host evidence is missing: {error}",)
    if not stat.S_ISREG(mode):
        return ("host evidence is not a regular evaluator file",)
    evidence_sha256 = _sha256(evidence_path)
    if status.get("host_evidence_sha256") != evidence_sha256:
        return ("run status does not bind host evidence",)
    try:
        raw: object = json.loads(evidence_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return (f"host evidence is malformed: {error}",)
    if not isinstance(raw, dict):
        return ("host evidence is not an object",)

    post_path = layout.evaluator_workspace / "post-run-hashes.json"
    try:
        post_mode = post_path.lstat().st_mode
        post_raw: object = json.loads(post_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return (f"post-run hash evidence is unavailable: {error}",)
    if not stat.S_ISREG(post_mode) or not isinstance(post_raw, dict):
        return ("post-run hash evidence is not a regular JSON object",)

    expected: dict[str, object] = {
        "baseline_hashes_sha256": layout.baseline_hashes_sha256,
        "final_response_sha256": _text_sha256(final_response),
        "host": host.value,
        "metadata_sha256": _sha256(layout.metadata_path),
        "post_run_hashes_sha256": _sha256(post_path),
        "post_run_tree_sha256": _mapping_sha256(post_run_hashes),
        "pre_run_tree_sha256": _mapping_sha256(layout.pre_run_hashes),
        "trace_path": trace_path.relative_to(layout.evaluator_workspace.resolve()).as_posix(),
        "trace_sha256": _sha256(trace_path),
    }
    reasons = [
        f"host evidence {field} does not match evaluator observation"
        for field, value in expected.items()
        if raw.get(field) != value
    ]
    normalized_post = {
        key: value
        for key, value in post_raw.items()
        if isinstance(key, str) and isinstance(value, str)
    }
    if normalized_post != dict(post_run_hashes) or len(normalized_post) != len(post_raw):
        reasons.append("post-run hash artifact does not match evaluator workspace scan")
    return tuple(reasons)


def _protocol_differences(layout: RunLayout, final_response: str) -> tuple[str, ...]:
    try:
        actual = extract_result_json(final_response)
    except ProtocolError as error:
        return (f"protocol error: {error}",)
    try:
        expected = _load_oracle(layout.oracle_path)
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        return (f"hidden oracle is invalid: {error}",)
    return compare_results(actual, expected)


def _load_oracle(path: Path) -> tuple[ReportRecord, ...]:
    value: object = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError("oracle must be an array")
    records: list[ReportRecord] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ValueError(f"oracle record {index} must be an object")
        records.append(ReportRecord(**item))
    return tuple(records)


def _mechanical_findings(
    analysis: TraceAnalysis,
    source: str | None,
    probe_result: ProbeResult,
) -> tuple[Finding, ...]:
    findings: list[Finding] = []
    if source is not None:
        findings.extend(inspect_source(source, frozenset(sys.stdlib_module_names)))
    findings.extend(inspect_commands(analysis.commands))
    findings.extend(probe_result.findings)
    return tuple(findings)


def _collect_execution_evidence(
    analysis: TraceAnalysis,
    final_response: str,
    fixture_unchanged: bool,
    agent_workspace: Path,
    helper_digest: str | None,
) -> _CollectedEvidence:
    """Derive provenance without accepting agent-authored synthetic probe claims."""
    completions = {
        event.event_id: event.output
        for event in analysis.events
        if event.tool_name == "__tool_result__"
    }
    completion_events = {
        event.event_id: event
        for event in analysis.events
        if event.tool_name == "__tool_result__"
    }
    shell_events = tuple(
        event for event in analysis.events if _command_input(event.input) is not None
    )
    command_events = {
        event.event_id: event
        for event in shell_events
    }
    python_action_ids = {command.event_id for command in analysis.commands}
    helper = _helper_capture(analysis)
    helper_path = helper.path if helper is not None else None
    source_completion = (
        completion_events.get(helper.event_id)
        or command_events.get(helper.event_id)
        if helper is not None
        else None
    )
    source_completed = (
        helper is not None
        and helper_path is not None
        and helper_digest is not None
        and source_completion is not None
        and _successful_output(source_completion.output)
    )
    successful_real: list[tuple[NormalizedEvent, str, object]] = []
    for event_index, event in enumerate(shell_events):
        command = _command_input(event.input)
        if command is None or event.event_id not in python_action_ids:
            continue
        invocation = _matching_helper_invocation(command, helper_path)
        if (
            invocation is None
            or helper_path is None
            or not source_completed
            or helper_digest is None
            or source_completion is None
            or source_completion.position > event.position
            or not _invocation_uses_real_input(invocation[1])
        ):
            continue
        output = completions.get(event.event_id, event.output)
        if _output_exit_code(output) == 0 or (
            _output_exit_code(output) is None and _successful_output(output)
        ):
            successful_real.append((event, command, output))

    supplied = tuple(
        item
        for item in successful_real
        if _output_supplies_final_result(item[2], final_response)
    )
    spotcheck = any(
        _verified_spotcheck(
            event,
            completions.get(event.event_id, event.output),
            agent_workspace,
        )
        for event in shell_events
    )

    probes: list[NormalizedEvent] = []
    probe = _collect_probe_sequence(
        shell_events,
        completions,
        helper_path,
        helper_digest,
        source_completion.position if source_completion is not None else None,
        fixture_unchanged,
        agent_workspace,
    )
    if probe is None:
        probe = _collect_semantic_probe_sequence(
            shell_events,
            completions,
            helper_path,
            fixture_unchanged,
            agent_workspace,
        )
    if probe is not None:
        event, mutation, exit_code, stderr = probe
        probes.append(
            NormalizedEvent(
                event.position,
                event.event_id,
                "__collected_probe__",
                {
                    "probe": {
                        "copied_input": True,
                        "input_hashes_verified": True,
                        "mutation": mutation,
                        "real_fixture_unchanged": fixture_unchanged,
                        "same_helper": True,
                    }
                },
                {
                    "exit_code": exit_code,
                    "stderr": stderr,
                },
            )
        )

    hidden: list[str] = []
    if helper is None or helper_path is None:
        hidden.append("captured helper source path is unavailable")
    elif not source_completed:
        hidden.append("captured helper source was not successfully written")
    elif not successful_real:
        hidden.append("successful real-input helper execution was not captured")
    elif not supplied:
        hidden.append("helper output provenance for the final records was not captured")
    if not spotcheck:
        hidden.append("focused raw-record spot-check was not captured")
    return _CollectedEvidence(tuple(probes), tuple(hidden))


def _command_input(value: object) -> str | None:
    if not isinstance(value, dict):
        return None
    for key in ("command", "cmd", "script"):
        command = value.get(key)
        if isinstance(command, str):
            return command
        if isinstance(command, list) and all(isinstance(part, str) for part in command):
            return " ".join(command)
    return None


def _python_script_invocation(command: str) -> tuple[str, tuple[str, ...]] | None:
    if _has_active_shell_construct(command):
        return None
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return None
    if not tokens or any(token in {";", "&&", "||", "|"} for token in tokens):
        return None
    executable = Path(tokens[0]).name.lower()
    if re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", executable) is None:
        return None
    script_index = 1
    if len(tokens) > script_index and tokens[script_index] == "-B":
        script_index += 1
    if len(tokens) <= script_index:
        return None
    script = tokens[script_index]
    if script.startswith("-") or not script.lower().endswith(".py"):
        return None
    return script, tuple(tokens[script_index + 1 :])


def _matching_helper_invocation(
    command: str,
    helper_path: str | None,
) -> tuple[str, tuple[str, ...]] | None:
    if helper_path is None:
        return None
    for candidate in _command_execution_segments(command):
        invocation = _python_script_invocation(candidate)
        if invocation is not None and (
            _normalized_script_path(invocation[0])
            == _normalized_script_path(helper_path)
        ):
            return invocation
    return None


def _command_execution_segments(command: str) -> tuple[str, ...]:
    remainder = _after_first_heredoc(command)
    candidate = remainder.strip() if remainder is not None else command.strip()
    return (candidate,) if candidate else ()


def _after_first_heredoc(command: str) -> str | None:
    lines = command.splitlines()
    if not lines:
        return None
    match = re.search(
        r"<<-?\s*(?:['\"])?([A-Za-z_][A-Za-z0-9_]*)(?:['\"])?",
        lines[0],
    )
    if match is None:
        return None
    delimiter = match.group(1)
    for index, line in enumerate(lines[1:], 1):
        if line.lstrip("\t") == delimiter:
            return "\n".join(lines[index + 1 :])
    return None


def _invocation_uses_real_input(arguments: Sequence[str]) -> bool:
    return not arguments or any(
        argument in {".", "owners.json"}
        or argument.startswith("artifacts/run-")
        for argument in arguments
    )


def _normalized_script_path(path: str) -> str:
    return Path(path).as_posix().removeprefix("./")


def _has_active_shell_construct(command: str) -> bool:
    quote: str | None = None
    escaped = False
    for character in command:
        if escaped:
            escaped = False
            continue
        if character == "\\" and quote != "'":
            escaped = True
            continue
        if quote is not None:
            if character == quote:
                quote = None
            elif quote == '"' and character in {"$", "`"}:
                return True
            continue
        if character in {"'", '"'}:
            quote = character
            continue
        if character in {
            ";",
            "&",
            "|",
            "<",
            ">",
            "(",
            ")",
            "$",
            "`",
            "\n",
            "\r",
        }:
            return True
    return quote is not None or escaped


def _immediately_preceded_by_helper_hash(
    shell_events: Sequence[NormalizedEvent],
    execution_index: int,
    completions: Mapping[str, object],
    helper_path: str,
    helper_digest: str,
    after_position: int,
) -> bool:
    if execution_index == 0:
        return False
    hash_event = shell_events[execution_index - 1]
    if hash_event.position <= after_position:
        return False
    command = _command_input(hash_event.input)
    if command is None or _has_active_shell_construct(command):
        return False
    try:
        tokens = tuple(shlex.split(command, posix=True))
    except ValueError:
        return False
    if tokens != ("shasum", "-a", "256", helper_path):
        return False
    output = completions.get(hash_event.event_id, hash_event.output)
    return _sha256_output_matches(output, helper_digest, helper_path)


def _sha256_output_matches(output: object, digest: str, path: str) -> bool:
    if not _successful_output(output):
        return False
    match = re.fullmatch(
        r"([0-9a-f]{64})[ \t]+([^\r\n]+)\r?\n?",
        _output_text(output),
    )
    return match is not None and match.group(1) == digest and match.group(2) == path


def _verified_spotcheck(
    event: NormalizedEvent,
    output: object,
    agent_workspace: Path,
) -> bool:
    command = _command_input(event.input)
    if command is None or _has_active_shell_construct(command):
        return False
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return False
    if not tokens or not _successful_output(output):
        return False
    artifact_tokens = tuple(
        token
        for token in tokens[1:]
        if token.startswith("artifacts/run-") and token.endswith(".json")
    )
    if len(artifact_tokens) != 1 or tokens[0] not in {"cat", "head", "tail", "sed"}:
        return False
    captured = _output_text(output)
    if not captured:
        return False
    try:
        expected = _read_beneath(agent_workspace, Path(artifact_tokens[0])).decode(
            "utf-8"
        )
    except (OSError, UnicodeDecodeError, ValueError):
        return False
    if tokens[0] == "cat":
        return captured == expected
    if tokens[0] == "head":
        return expected.startswith(captured)
    if tokens[0] == "tail":
        return expected.endswith(captured)
    return all(line in expected for line in captured.splitlines())


def _collect_probe_sequence(
    events: Sequence[NormalizedEvent],
    completions: Mapping[str, object],
    helper_path: str | None,
    helper_digest: str | None,
    source_completion_position: int | None,
    fixture_unchanged: bool,
    agent_workspace: Path,
) -> tuple[NormalizedEvent, str, int, str] | None:
    if (
        helper_path is None
        or helper_digest is None
        or source_completion_position is None
        or not fixture_unchanged
    ):
        return None
    observed: list[tuple[NormalizedEvent, tuple[str, ...], object]] = []
    for event in events:
        command = _command_input(event.input)
        if command is None:
            continue
        try:
            tokens = tuple(shlex.split(command, posix=True))
        except ValueError:
            continue
        observed.append((event, tokens, completions.get(event.event_id, event.output)))

    for index, (temp_event, temp_tokens, temp_output) in enumerate(observed):
        if temp_tokens != ("mktemp", "-d", ".probe.XXXXXX") or not _successful_output(temp_output):
            continue
        temp_name = _output_text(temp_output).strip()
        if re.fullmatch(r"\.probe\.[A-Za-z0-9_-]{6,}", temp_name) is None:
            continue
        copied_path = f"{temp_name}/input.json"
        copy_index = _find_observed_step(
            observed,
            index + 1,
            lambda tokens: len(tokens) == 3
            and tokens[0] == "cp"
            and tokens[1].startswith("artifacts/run-")
            and tokens[1].endswith(".json")
            and tokens[2] == copied_path,
            successful=True,
        )
        if copy_index is None:
            continue
        mutation_index, mutation = _find_mutation_step(
            observed,
            copy_index + 1,
            copied_path,
        )
        if mutation_index is None or mutation is None:
            continue
        expected_mutated_sha256 = _expected_mutated_sha256(
            agent_workspace,
            observed[copy_index][1][1],
            mutation,
        )
        if expected_mutated_sha256 is None:
            continue
        hash_index = _find_observed_step(
            observed,
            mutation_index + 1,
            lambda tokens: tokens
            == ("shasum", "-a", "256", copied_path),
            successful=True,
        )
        if hash_index is None:
            continue
        reported_hash = _output_text(observed[hash_index][2]).split()
        if not reported_hash or reported_hash[0] != expected_mutated_sha256:
            continue
        run_index = _find_observed_step(
            observed,
            hash_index + 1,
            lambda tokens: _tokens_run_helper(tokens, helper_path, copied_path),
            successful=False,
        )
        if run_index is None:
            continue
        if not _observed_helper_hash_before_run(
            observed,
            run_index,
            helper_path,
            helper_digest,
            source_completion_position,
        ):
            continue
        run_event, _, run_output = observed[run_index]
        exit_code = _output_exit_code(run_output)
        stderr = _output_stderr(run_output)
        if exit_code is None or exit_code == 0 or not stderr:
            continue
        cleanup_index = _find_observed_step(
            observed,
            run_index + 1,
            lambda tokens: tokens in {
                ("rm", "-rf", temp_name),
                ("rm", "-r", temp_name),
            },
            successful=True,
        )
        if cleanup_index is None or os.path.lexists(agent_workspace / temp_name):
            continue
        return run_event, mutation, exit_code, stderr
    return None


def _collect_semantic_probe_sequence(
    events: Sequence[NormalizedEvent],
    completions: Mapping[str, object],
    helper_path: str | None,
    fixture_unchanged: bool,
    agent_workspace: Path,
) -> tuple[NormalizedEvent, str, int, str] | None:
    """Recognize equivalent observed probe steps without prescribing spellings."""
    if helper_path is None or not fixture_unchanged:
        return None
    observed: list[tuple[NormalizedEvent, tuple[str, ...], object]] = []
    for event in events:
        command = _command_input(event.input)
        if command is None or _has_active_shell_construct(command):
            continue
        try:
            tokens = tuple(shlex.split(command, posix=True))
        except ValueError:
            continue
        observed.append((event, tokens, completions.get(event.event_id, event.output)))

    for temp_index, (temp_event, temp_tokens, temp_output) in enumerate(observed):
        if (
            not temp_tokens
            or temp_tokens[0] != "mktemp"
            or "-d" not in temp_tokens[1:]
            or not _successful_output(temp_output)
        ):
            continue
        temp_name = _output_text(temp_output).strip()
        if not _safe_observed_temp_name(temp_name):
            continue
        copy_index: int | None = None
        copied_path: str | None = None
        for index in range(temp_index + 1, len(observed)):
            _, tokens, output = observed[index]
            if (
                len(tokens) == 3
                and tokens[0] == "cp"
                and tokens[1].startswith("artifacts/run-")
                and tokens[1].endswith(".json")
                and _path_is_beneath_text(tokens[2], temp_name)
                and _successful_output(output)
            ):
                copy_index = index
                copied_path = tokens[2]
                break
        if copy_index is None or copied_path is None:
            continue
        mutation_index, mutation = _find_mutation_step(
            observed,
            copy_index + 1,
            copied_path,
        )
        if mutation_index is None or mutation is None:
            continue
        run_index = _find_observed_step(
            observed,
            mutation_index + 1,
            lambda tokens: _tokens_run_helper_semantically(
                tokens,
                helper_path,
                temp_name,
                copied_path,
            ),
            successful=False,
        )
        if run_index is None:
            continue
        run_event, _, run_output = observed[run_index]
        exit_code = _output_exit_code(run_output)
        stderr = _output_stderr(run_output)
        if exit_code is None or exit_code == 0 or not stderr:
            continue
        cleanup_index = _find_observed_step(
            observed,
            run_index + 1,
            lambda tokens: _tokens_remove_temp(tokens, temp_name),
            successful=True,
        )
        if cleanup_index is None or os.path.lexists(agent_workspace / temp_name):
            continue
        return run_event, mutation, exit_code, stderr
    return None


def _safe_observed_temp_name(value: str) -> bool:
    path = Path(value)
    return (
        bool(value)
        and not path.is_absolute()
        and all(part not in {"", ".", ".."} for part in path.parts)
        and re.fullmatch(r"[A-Za-z0-9._/-]+", value) is not None
    )


def _path_is_beneath_text(path: str, parent: str) -> bool:
    candidate = Path(path)
    root = Path(parent)
    return candidate != root and candidate.is_relative_to(root)


def _tokens_run_helper_semantically(
    tokens: tuple[str, ...],
    helper_path: str,
    temp_name: str,
    copied_path: str,
) -> bool:
    invocation = _python_script_invocation(shlex.join(tokens))
    if invocation is None or (
        _normalized_script_path(invocation[0])
        != _normalized_script_path(helper_path)
    ):
        return False
    return any(
        argument in {temp_name, copied_path}
        or _path_is_beneath_text(argument, temp_name)
        for argument in invocation[1]
    )


def _tokens_remove_temp(tokens: tuple[str, ...], temp_name: str) -> bool:
    return (
        len(tokens) >= 2
        and tokens[0] == "rm"
        and tokens[-1] == temp_name
        and all(token == "rm" or token.startswith("-") or token == temp_name for token in tokens)
    )


def _observed_helper_hash_before_run(
    observed: Sequence[tuple[NormalizedEvent, tuple[str, ...], object]],
    run_index: int,
    helper_path: str,
    helper_digest: str,
    after_position: int,
) -> bool:
    if run_index == 0:
        return False
    event, tokens, output = observed[run_index - 1]
    return (
        event.position > after_position
        and tokens == ("shasum", "-a", "256", helper_path)
        and _sha256_output_matches(output, helper_digest, helper_path)
    )


def _expected_mutated_sha256(
    agent_workspace: Path,
    source_relative: str,
    mutation: str,
) -> str | None:
    try:
        decoded: object = json.loads(
            _read_beneath(agent_workspace, Path(source_relative)).decode("utf-8")
        )
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None
    if not isinstance(decoded, dict):
        return None
    tests = decoded.get("tests")
    if not isinstance(tests, list) or not tests or not isinstance(tests[0], dict):
        return None
    attempts = tests[0].get("attempts")
    if not isinstance(attempts, list) or not attempts or not isinstance(attempts[0], dict):
        return None
    if mutation == "boolean-attempt":
        attempts[0]["attempt"] = True
    elif mutation == "unknown-outcome":
        attempts[0]["outcome"] = "unknown"
    else:
        return None
    encoded = (
        json.dumps(
            decoded,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _find_observed_step(
    observed: Sequence[tuple[NormalizedEvent, tuple[str, ...], object]],
    start: int,
    predicate: Callable[[tuple[str, ...]], bool],
    *,
    successful: bool,
) -> int | None:
    for index in range(start, len(observed)):
        _, tokens, output = observed[index]
        if predicate(tokens) and _successful_output(output) is successful:
            return index
    return None


def _find_mutation_step(
    observed: Sequence[tuple[NormalizedEvent, tuple[str, ...], object]],
    start: int,
    copied_path: str,
) -> tuple[int | None, str | None]:
    for index in range(start, len(observed)):
        _, tokens, output = observed[index]
        if len(tokens) < 4 or tokens[0] not in {"python", "python3"} or tokens[1] != "-c":
            continue
        source = tokens[2]
        if tokens[-1] != copied_path or not _successful_output(output):
            continue
        writes_copy = (
            "open(p,\"w\")" in source
            or "open(p,'w')" in source
            or "write_text(" in source
            or "json.dump(" in source
        )
        if not writes_copy:
            continue
        if re.search(r"attempt.+(?:True|False)", source, re.S) is not None:
            return index, "boolean-attempt"
        if re.search(r"outcome.+(?:unknown|invalid|bogus)", source, re.I | re.S) is not None:
            return index, "unknown-outcome"
    return None, None


def _tokens_run_helper(
    tokens: tuple[str, ...], helper_path: str, copied_path: str
) -> bool:
    if len(tokens) != 3:
        return False
    executable = Path(tokens[0]).name.lower()
    return (
        re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", executable) is not None
        and _normalized_script_path(tokens[1]) == _normalized_script_path(helper_path)
        and tokens[2] == copied_path
    )


def _output_exit_code(output: object) -> int | None:
    if isinstance(output, dict):
        value = output.get("exit_code")
        if isinstance(value, int) and not isinstance(value, bool):
            return value
        for key in ("output", "content", "result"):
            nested = _output_exit_code(output.get(key))
            if nested is not None:
                return nested
    elif isinstance(output, list):
        for item in output:
            nested = _output_exit_code(item)
            if nested is not None:
                return nested
    elif isinstance(output, str):
        match = re.search(r"\bexit(?:ed|\s+code)?\s*[:=]?\s*(-?\d+)\b", output, re.I)
        if match is not None:
            return int(match.group(1))
    return None


def _output_stderr(output: object) -> str:
    if isinstance(output, dict):
        stderr = output.get("stderr")
        if isinstance(stderr, str):
            return stderr.strip()
    text = _output_text(output)
    return re.sub(r"^.*?exit(?:ed|\s+code)?\s*[:=]?\s*-?\d+\s*", "", text, count=1, flags=re.I | re.S).strip()


def _output_text(output: object) -> str:
    if isinstance(output, str):
        return output
    if isinstance(output, dict):
        return "\n".join(
            _output_text(output[key])
            for key in ("stdout", "stderr", "output", "content", "result")
            if key in output
        )
    if isinstance(output, list):
        return "\n".join(_output_text(item) for item in output)
    return ""


def _output_supplies_final_result(output: object, final_response: str) -> bool:
    try:
        captured = extract_result_json(_output_text(output))
        final = extract_result_json(final_response)
    except ProtocolError:
        return False
    return captured == final


def _helper_source(analysis: TraceAnalysis) -> str | None:
    captured = _helper_capture(analysis)
    return captured.source if captured is not None else None


def _helper_capture(analysis: TraceAnalysis) -> CapturedSource | None:
    file_sources = tuple(
        captured
        for captured in analysis.sources
        if captured.path is not None and captured.path.lower().endswith(".py")
    )
    if file_sources:
        return file_sources[-1]
    if analysis.sources:
        return analysis.sources[0]
    return None


def _routing_findings(
    host: Host,
    analysis: TraceAnalysis,
    discovered_skills: Sequence[str],
) -> tuple[Finding, ...]:
    findings: list[Finding] = []
    observable = host is Host.CLAUDE or any(
        "skill" in event.tool_name.lower() or "resource" in event.tool_name.lower()
        for event in analysis.events
    )
    first_position = (
        analysis.python_actions[0].position if analysis.python_actions else None
    )
    typing_position = _skill_position(analysis.events, _TYPING_SKILL)
    if observable and first_position is not None and (
        typing_position is None or typing_position >= first_position
    ):
        findings.append(
            Finding(
                "missing-python-typing-routing",
                "python-typing was not accepted before helper construction",
            )
        )
    for unexpected in sorted(_UNEXPECTED_SKILLS.intersection(discovered_skills)):
        findings.append(Finding("unexpected-skill-routing", unexpected))
    return tuple(findings)


def _discovered_skills(analysis: TraceAnalysis) -> tuple[str, ...]:
    positioned: list[tuple[int, str]] = [
        (evidence.position, _SIMPLE_SKILL)
        for evidence in analysis.skill_events
    ]
    for skill in (_TYPING_SKILL, *_UNEXPECTED_SKILLS):
        position = _skill_position(analysis.events, skill)
        if position is not None:
            positioned.append((position, skill))
    seen: set[str] = set()
    ordered: list[str] = []
    for _, skill in sorted(positioned):
        if skill not in seen:
            seen.add(skill)
            ordered.append(skill)
    return tuple(ordered)


def _skill_position(events: Sequence[NormalizedEvent], target: str) -> int | None:
    completions = {
        event.event_id: event
        for event in events
        if event.tool_name == "__tool_result__"
    }
    target_file = target.split(":", 1)[-1] + "/SKILL.md"
    for event in events:
        mapping = event.input if isinstance(event.input, dict) else None
        if mapping is None:
            continue
        names_target = mapping.get("skill") == target or any(
            target_file in text for text in _strings(mapping)
        )
        if not names_target:
            continue
        completion = completions.get(event.event_id)
        if completion is not None and _successful_output(completion.output):
            return completion.position
        if event.output is not None and _successful_output(event.output):
            return event.position
    return None


def _successful_output(output: object) -> bool:
    if not isinstance(output, dict):
        return output is not None
    if output.get("is_error") is True or output.get("success") is False:
        return False
    status = output.get("status")
    if isinstance(status, str):
        return status.lower() in {"completed", "success", "succeeded", "ok"}
    exit_code = output.get("exit_code")
    if isinstance(exit_code, int) and not isinstance(exit_code, bool):
        return exit_code == 0
    return bool(output)


def _strings(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,)
    if isinstance(value, dict):
        return tuple(text for item in value.values() for text in _strings(item))
    if isinstance(value, list):
        return tuple(text for item in value for text in _strings(item))
    return ()


def _semantic_review(layout: RunLayout) -> SemanticNotes:
    path = layout.evaluator_workspace / "semantic-review.json"
    raw: object = None
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = None
    mapping = raw if isinstance(raw, dict) else {}
    return {
        "proportionate_helper": _review_value(mapping.get("proportionate_helper")),
        "sound_typed_narrowing": _review_value(mapping.get("sound_typed_narrowing")),
    }


def _review_value(value: object) -> ReviewValue:
    if not isinstance(value, dict):
        return {"approved": None, "notes": None}
    approved = value.get("approved")
    notes = value.get("notes")
    return {
        "approved": approved if isinstance(approved, bool) else None,
        "notes": notes if isinstance(notes, str) else None,
    }


def _empty_semantic_review() -> SemanticNotes:
    return {
        "proportionate_helper": {"approved": None, "notes": None},
        "sound_typed_narrowing": {"approved": None, "notes": None},
    }


def _compose_compliance(
    base_state: VerdictState,
    base_reasons: Sequence[str],
    findings: Sequence[Finding],
) -> Outcome:
    failure_reasons = tuple(dict.fromkeys(finding.code for finding in findings))
    if base_state is VerdictState.FAIL:
        failure_reasons = tuple(dict.fromkeys((*base_reasons, *failure_reasons)))
    if failure_reasons:
        return Outcome("FAIL", failure_reasons)
    if base_state is VerdictState.UNOBSERVABLE:
        return Outcome("UNOBSERVABLE", tuple(base_reasons))
    if base_reasons:
        return Outcome("UNOBSERVABLE", tuple(dict.fromkeys(base_reasons)))
    return Outcome("PASS")


def _metadata(layout: RunLayout, host: Host) -> dict[str, object]:
    try:
        raw: object = json.loads(layout.metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raw = {}
    metadata = dict(raw) if isinstance(raw, dict) else {}
    metadata["host"] = host.value
    metadata.setdefault("repository_revision", layout.repository_revision)
    metadata.setdefault("fixture_schema_version", layout.fixture_manifest.schema_version)
    metadata.setdefault("fixture_seed", layout.fixture_manifest.seed)
    return metadata


def _event_json(event: NormalizedEvent) -> dict[str, object]:
    return {
        "event_id": event.event_id,
        "input": event.input,
        "position": event.position,
        "tool_name": event.tool_name,
    }


def _current_plugin_hash(root: Path) -> str:
    files, unsafe = _regular_files(root)
    if unsafe:
        raise ValueError("; ".join(unsafe))
    digest = hashlib.sha256()
    for path in files:
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        content = _read_regular_file(path)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _write_report(layout: RunLayout, report: EvaluationReport) -> None:
    (layout.evaluator_workspace / "evaluation.json").write_text(
        json.dumps(report.to_json(), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Run or reevaluate retained evidence with stable outcome exit statuses."""
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] == "reevaluate":
        return _main_reevaluate(arguments[1:])
    if arguments and arguments[0] == "run":
        arguments = arguments[1:]
    return _main_run(arguments)


def _main_run(argv: Sequence[str]) -> int:
    """Run a host once and retain a complete bundle for semantic review."""
    parser = argparse.ArgumentParser(
        description="Run an isolated python-scripting host evaluation.",
        epilog=(
            "Exit status: 0 accepted; 1 valid but discovery/compliance did not pass; "
            "2 command-line usage; 3 invalid harness run; 70 orchestration failure."
        ),
    )
    parser.add_argument(
        "--host",
        choices=tuple(host.value for host in Host),
        required=True,
    )
    parser.add_argument("--model", required=True, type=_nonempty_model)
    parser.add_argument("--output-root", required=True, type=Path)
    arguments = parser.parse_args(argv)

    repository = Path(__file__).resolve().parents[4]
    output_root = arguments.output_root.expanduser().resolve(strict=False)
    if output_root == repository or output_root.is_relative_to(repository):
        parser.error("--output-root must resolve outside the repository")

    layout: RunLayout | None = None
    report: EvaluationReport | None = None
    retained_evaluation: Path | None = None
    cleanup_failed = False
    try:
        layout = prepare_run(repository, output_root)
        host = Host(arguments.host)
        completed = run_host(host, layout, arguments.model)
        _write_semantic_review_template(
            layout.evaluator_workspace / "semantic-review.json"
        )
        report = evaluate_run(
            layout,
            host,
            completed.trace_path,
            completed.final_response,
        )
        retained_evaluation = _retain_evidence(
            layout,
            output_root,
            host,
            completed.trace_path,
        )
    except Exception:
        # Host details may contain credential material. The retained evidence carries
        # redacted diagnostics when the normal runner reaches its audit boundary.
        pass
    finally:
        if layout is not None:
            try:
                layout.cleanup()
            except OSError:
                cleanup_failed = True

    if report is None or retained_evaluation is None or cleanup_failed:
        print("evaluation orchestration failed", file=sys.stderr)
        return 70
    print(retained_evaluation)
    return _report_exit_status(report)


def _main_reevaluate(argv: Sequence[str]) -> int:
    """Verify a retained bundle and update its evaluation from human review."""
    parser = argparse.ArgumentParser(
        description="Reevaluate a retained python-scripting evidence bundle.",
        epilog=(
            "Exit status: 0 accepted; 1 valid but discovery/compliance did not pass; "
            "2 command-line usage; 3 invalid harness run; 70 reevaluation failure."
        ),
    )
    parser.add_argument("--evidence", required=True, type=Path)
    arguments = parser.parse_args(argv)
    try:
        retained = _retained_root(arguments.evidence)
        layout, host, trace_path, final_response = _load_retained_bundle(retained)
        report = evaluate_run(layout, host, trace_path, final_response)
    except Exception:
        print("reevaluation failed", file=sys.stderr)
        return 70
    evaluation_path = retained / "evaluation.json"
    print(evaluation_path)
    return _report_exit_status(report)


def _report_exit_status(report: EvaluationReport) -> int:
    if report.validity.state != "VALID":
        return 3
    if report.discovery.state != "PASS" or report.compliance.state != "PASS":
        return 1
    return 0


def _nonempty_model(value: str) -> str:
    model = value.strip()
    if not model:
        raise argparse.ArgumentTypeError("--model must not be empty")
    return model


def _retain_evidence(
    layout: RunLayout,
    output_root: Path,
    host: Host,
    trace_path: Path,
) -> Path:
    destination = Path(mkdtemp(prefix="python-scripting-evidence-", dir=output_root))
    shutil.copytree(
        layout.evaluator_workspace,
        destination,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns(layout.codex_home.name),
    )
    shutil.copytree(layout.agent_workspace, destination / "agent-workspace")
    shutil.copytree(layout.staged_marketplace, destination / "staged-marketplace")
    evaluation_path = destination / "evaluation.json"
    if not evaluation_path.is_file():
        raise ValueError("evaluator did not write evaluation.json")
    trace_relative = trace_path.relative_to(layout.evaluator_workspace).as_posix()
    immutable_files = _retained_file_hashes(destination)
    _write_json_value(
        destination / "retained-bundle.json",
        {
            "host": host.value,
            "immutable_files": immutable_files,
            "layout": {
                "baseline_hashes_sha256": layout.baseline_hashes_sha256,
                "manifest_sha256": layout.manifest_sha256,
                "minimal_path": layout.minimal_path,
                "oracle_sha256": layout.oracle_sha256,
                "plugin_sha256": layout.plugin_sha256,
                "repository_revision": layout.repository_revision,
            },
            "schema_version": 1,
            "trace_path": trace_relative,
        },
    )
    return evaluation_path


def _write_semantic_review_template(path: Path) -> None:
    _write_json_value(
        path,
        {
            "proportionate_helper": {"approved": None, "notes": ""},
            "sound_typed_narrowing": {"approved": None, "notes": ""},
        },
    )


def _retained_root(evidence: Path) -> Path:
    candidate = evidence.expanduser().resolve(strict=True)
    root = candidate if candidate.is_dir() else candidate.parent
    repository = Path(__file__).resolve().parents[4]
    if root == repository or root.is_relative_to(repository):
        raise ValueError("retained evidence must be outside the repository")
    return root


def _load_retained_bundle(
    root: Path,
) -> tuple[RunLayout, Host, Path, str]:
    bundle = _read_json_object(root / "retained-bundle.json")
    if bundle.get("schema_version") != 1:
        raise ValueError("unsupported retained bundle schema")
    _verify_retained_file_hashes(root, bundle.get("immutable_files"))
    layout_values = bundle.get("layout")
    if not isinstance(layout_values, dict):
        raise ValueError("retained bundle layout is malformed")
    host_value = bundle.get("host")
    if not isinstance(host_value, str):
        raise ValueError("retained bundle host is malformed")
    host = Host(host_value)
    trace_relative = _safe_relative_path(bundle.get("trace_path"))
    trace_path = (root / trace_relative).resolve(strict=True)
    if not trace_path.is_relative_to(root):
        raise ValueError("retained trace escapes its bundle")

    fixture_manifest = _load_fixture_manifest(root / "fixture-manifest.json")
    pre_run_hashes = _string_mapping(
        _read_json_object(root / "baseline-hashes.json"),
        "baseline hashes",
    )
    layout = RunLayout(
        repo_root=Path(__file__).resolve().parents[4],
        agent_workspace=root / "agent-workspace",
        staged_marketplace=root / "staged-marketplace",
        staged_plugin=root / "staged-marketplace" / "plugins" / "python-scripting",
        evaluator_workspace=root,
        codex_home=root / ".codex-home",
        marketplace_manifest=(
            root
            / "staged-marketplace"
            / ".agents"
            / "plugins"
            / "marketplace.json"
        ),
        fixture_manifest_path=root / "fixture-manifest.json",
        baseline_hashes_path=root / "baseline-hashes.json",
        baseline_hashes_sha256=_required_string(
            layout_values, "baseline_hashes_sha256"
        ),
        oracle_path=root / "oracle.json",
        metadata_path=root / "run-metadata.json",
        prompt_path=root / "prompt.txt",
        codex_config_path=root / "config.toml",
        claude_sandbox_profile=root / "claude.sb",
        repository_sentinel=root / "repository-sentinel",
        evaluator_sentinel=root / "deny-sentinel",
        pre_run_hashes=pre_run_hashes,
        fixture_manifest=fixture_manifest,
        plugin_sha256=_required_string(layout_values, "plugin_sha256"),
        manifest_sha256=_required_string(layout_values, "manifest_sha256"),
        oracle_sha256=_required_string(layout_values, "oracle_sha256"),
        repository_revision=_required_string(
            layout_values, "repository_revision"
        ),
        minimal_path=_required_string(layout_values, "minimal_path"),
        codex_executable=Path("codex"),
        claude_executable=Path("claude"),
        sandbox_executable=Path("sandbox-exec"),
        _temporary_directories=(),
    )
    records = _read_jsonl(trace_path)
    final_response = (
        _codex_final_response(records)
        if host is Host.CODEX
        else _claude_final_response(records)
    )
    return layout, host, trace_path, final_response


def _retained_file_hashes(root: Path) -> dict[str, str]:
    mutable = frozenset(
        {"evaluation.json", "retained-bundle.json", "semantic-review.json"}
    )
    files, unsafe = _regular_files(root)
    if unsafe:
        raise ValueError("retained evidence contains unsafe entries")
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(
            _read_beneath(root, path.relative_to(root))
        ).hexdigest()
        for path in files
        if path.relative_to(root).as_posix() not in mutable
    }


def _verify_retained_file_hashes(root: Path, value: object) -> None:
    expected = _string_mapping(value, "retained immutable files")
    if not expected:
        raise ValueError("retained bundle has no immutable evidence")
    for relative, digest in expected.items():
        path = _safe_relative_path(relative)
        try:
            actual = hashlib.sha256(_read_beneath(root, path)).hexdigest()
        except (OSError, ValueError) as error:
            raise ValueError(f"retained evidence is unavailable: {relative}") from error
        if actual != digest:
            raise ValueError(f"retained evidence hash changed: {relative}")


def _load_fixture_manifest(path: Path) -> FixtureManifest:
    raw = _read_json_object(path)
    files = raw.get("files")
    if not isinstance(files, list):
        raise ValueError("fixture manifest files are malformed")
    digests: list[FileDigest] = []
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("fixture manifest file entry is malformed")
        digest_path = item.get("path")
        sha256 = item.get("sha256")
        byte_count = item.get("byte_count")
        if (
            not isinstance(digest_path, str)
            or not isinstance(sha256, str)
            or type(byte_count) is not int
        ):
            raise ValueError("fixture manifest file entry is malformed")
        digests.append(FileDigest(digest_path, sha256, byte_count))
    integer_fields: dict[str, int] = {}
    for name in (
        "schema_version",
        "seed",
        "run_count",
        "test_id_count",
        "attempt_count",
    ):
        value = raw.get(name)
        if type(value) is not int:
            raise ValueError(f"fixture manifest {name} is malformed")
        integer_fields[name] = value
    return FixtureManifest(files=tuple(digests), **integer_fields)


def _read_json_object(path: Path) -> dict[str, object]:
    try:
        raw: object = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid retained JSON: {path.name}") from error
    if not isinstance(raw, dict):
        raise ValueError(f"retained JSON must be an object: {path.name}")
    return raw


def _string_mapping(value: object, label: str) -> dict[str, str]:
    if not isinstance(value, dict) or not all(
        isinstance(key, str) and isinstance(item, str)
        for key, item in value.items()
    ):
        raise ValueError(f"{label} must map strings to strings")
    return dict(value)


def _required_string(mapping: Mapping[str, object], key: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"retained bundle {key} is missing")
    return value


def _safe_relative_path(value: object) -> Path:
    if not isinstance(value, str):
        raise ValueError("retained bundle path is malformed")
    path = Path(value)
    if path.is_absolute() or not path.parts or any(
        part in {"", ".", ".."} for part in path.parts
    ):
        raise ValueError("retained bundle path is unsafe")
    return path


def _write_json_value(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    raise SystemExit(main())
