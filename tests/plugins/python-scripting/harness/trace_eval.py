"""Normalize host JSONL traces and evaluate skill-discovery ordering."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import json
from pathlib import Path
import re
import shlex
from typing import Final


class Host(Enum):
    """Host-specific trace dialects understood by this evaluator."""

    CLAUDE = "claude"
    CODEX = "codex"


class VerdictState(Enum):
    """A three-state result that preserves missing observability."""

    PASS = "PASS"
    FAIL = "FAIL"
    UNOBSERVABLE = "UNOBSERVABLE"


@dataclass(frozen=True)
class Verdict:
    """A verdict with stable, audit-friendly reasons."""

    state: VerdictState
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class NormalizedEvent:
    """One host tool or resource event at an encoded sortable stream position."""

    position: int
    event_id: str
    tool_name: str
    input: object
    output: object


@dataclass(frozen=True)
class Evidence:
    """Accepted successful skill evidence, retaining its originating call ID."""

    position: int
    event_id: str
    kind: str
    detail: str


@dataclass(frozen=True)
class CapturedCommand:
    """A shell command preserved for provenance and compliance review."""

    position: int
    event_id: str
    command: str


@dataclass(frozen=True)
class CapturedSource:
    """Reconstructed source and the trace mechanism that exposed it."""

    position: int
    event_id: str
    source: str
    origin: str
    path: str | None = None


@dataclass(frozen=True)
class TraceAnalysis:
    """Normalized trace data and its independent discovery conclusion."""

    events: tuple[NormalizedEvent, ...]
    skill_events: tuple[Evidence, ...]
    python_actions: tuple[NormalizedEvent, ...]
    commands: tuple[CapturedCommand, ...]
    sources: tuple[CapturedSource, ...]
    source_observable: bool
    discovery: Verdict


class TraceFormatError(ValueError):
    """Raised when a trace cannot be trusted as JSONL input."""


_TARGET_SKILL: Final[str] = "python-scripting:python-simple-scripts"
_TARGET_SKILL_FILE: Final[str] = "python-simple-scripts/SKILL.md"
_POSITION_SCALE: Final[int] = 1_000_000
_PYTHON_FILE: Final[re.Pattern[str]] = re.compile(r"\.py(?:\Z|[\s'\"`])", re.I)
_PYTHON_INTERPRETER: Final[re.Pattern[str]] = re.compile(
    r"(?:.*/)?python(?:\d+(?:\.\d+)*)?\Z", re.I
)
_SHELL_TOOLS: Final[frozenset[str]] = frozenset(
    {
        "bash",
        "shell",
        "terminal",
        "exec",
        "exec_command",
        "run",
        "run_command",
        "execute",
    }
)
_SOURCE_TOOLS: Final[frozenset[str]] = frozenset(
    {
        "write",
        "edit",
        "apply_patch",
        "patch",
        "edit_file",
        "write_file",
        "file_change",
    }
)
_RUNNER_PREFIXES: Final[frozenset[tuple[str, str]]] = frozenset(
    {
        ("uv", "run"),
        ("poetry", "run"),
        ("pipenv", "run"),
        ("rye", "run"),
        ("pixi", "run"),
        ("mise", "exec"),
    }
)


def analyze_trace(host: Host, path: Path) -> TraceAnalysis:
    """Load one complete host JSONL trace without changing its event order."""
    events = _normalize_trace(host, path)
    skill_events = _accepted_skill_events(host, events)
    python_actions = tuple(
        event for event in events if is_python_action(event.tool_name, event.input)
    )
    commands = tuple(
        CapturedCommand(event.position, event.event_id, command)
        for event in events
        if event.tool_name.lower() in _SHELL_TOOLS
        if (command := _command_from_input(event.input)) is not None
    )
    sources, source_observable = _capture_sources(events)
    observable = _host_skill_events_observable(host, events)
    return TraceAnalysis(
        events=events,
        skill_events=skill_events,
        python_actions=python_actions,
        commands=commands,
        sources=sources,
        source_observable=source_observable,
        discovery=classify_discovery(host, skill_events, python_actions, observable),
    )


def classify_discovery(
    host: Host,
    skill_events: tuple[Evidence, ...],
    python_actions: tuple[NormalizedEvent, ...],
    observable: bool,
) -> Verdict:
    """Apply the approved discovery ordering decision table."""
    del host
    if not python_actions:
        return Verdict(VerdictState.FAIL, ("no Python construction or execution",))

    first_action = python_actions[0]
    if any(evidence.position < first_action.position for evidence in skill_events):
        return Verdict(VerdictState.PASS)
    if skill_events:
        return Verdict(
            VerdictState.FAIL,
            ("accepted skill evidence occurred after first Python action",),
        )
    if observable:
        return Verdict(VerdictState.FAIL, ("no accepted skill evidence",))
    return Verdict(
        VerdictState.UNOBSERVABLE,
        ("host trace exposes no skill-use event",),
    )


def is_python_action(tool_name: str, tool_input: object) -> bool:
    """Return whether one tool call can construct or execute Python."""
    name = tool_name.lower()
    mapping = _as_mapping(tool_input)
    if mapping is None:
        return False
    if name in _SOURCE_TOOLS:
        return _source_tool_targets_python(name, mapping)
    if name not in _SHELL_TOOLS:
        return False
    command = _command_from_input(mapping)
    return command is not None and _command_constructs_or_executes_python(command)


def _normalize_trace(host: Host, path: Path) -> tuple[NormalizedEvent, ...]:
    events: list[NormalizedEvent] = []
    for position, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            raise TraceFormatError(f"malformed JSONL at line {position}: empty line")
        record = _parse_json_line(line, position)
        snapshot = _normalize_source_snapshot(record, position)
        if snapshot is not None:
            events.append(snapshot)
            continue
        if host is Host.CLAUDE:
            events.extend(_normalize_claude_record(record, position))
        else:
            events.extend(_normalize_codex_record(record, position))
    return tuple(events)


def _normalize_source_snapshot(
    record: dict[str, object], position: int
) -> NormalizedEvent | None:
    if record.get("type") not in {"source_snapshot", "post_run_source_snapshot"}:
        return None
    path = record.get("path")
    source = record.get("content", record.get("source"))
    if not isinstance(path, str) or not isinstance(source, str):
        raise TraceFormatError(
            f"malformed JSONL at line {position}: source snapshot needs path and content"
        )
    return NormalizedEvent(
        _stream_position(position),
        _string_value(record.get("id"), f"line-{position}"),
        "__source_snapshot__",
        {"path": path, "content": source},
        {"status": "completed"},
    )


def _parse_json_line(line: str, position: int) -> dict[str, object]:
    try:
        decoded: object = json.loads(line)
    except json.JSONDecodeError as error:
        raise TraceFormatError(f"malformed JSONL at line {position}: {error.msg}") from error
    if not isinstance(decoded, dict):
        raise TraceFormatError(f"malformed JSONL at line {position}: expected object")
    return decoded


def _normalize_claude_record(
    record: dict[str, object], position: int
) -> tuple[NormalizedEvent, ...]:
    message = _as_mapping(record.get("message"))
    if message is None:
        return ()
    contents = message.get("content")
    if not isinstance(contents, list):
        return ()

    events: list[NormalizedEvent] = []
    for index, block in enumerate(contents):
        item = _as_mapping(block)
        if item is None:
            continue
        kind = item.get("type")
        if kind == "tool_use":
            name = item.get("name")
            if not isinstance(name, str):
                continue
            event_id = _string_value(item.get("id"), f"line-{position}-{index}")
            events.append(
                NormalizedEvent(
                    _stream_position(position, index),
                    event_id,
                    name,
                    item.get("input", {}),
                    item.get("output"),
                )
            )
        elif kind == "tool_result":
            event_id = _string_value(item.get("tool_use_id"), f"line-{position}-{index}")
            events.append(
                NormalizedEvent(
                    _stream_position(position, index), event_id, "__tool_result__", {}, item
                )
            )
    return tuple(events)


def _normalize_codex_record(
    record: dict[str, object], position: int
) -> tuple[NormalizedEvent, ...]:
    item = _as_mapping(record.get("item")) or record
    kind = item.get("type")
    if kind in {
        "function_call_output",
        "tool_result",
        "resource_read_result",
        "resource_result",
    }:
        event_id = _string_value(
            item.get("call_id", item.get("tool_use_id", item.get("id"))),
            f"line-{position}",
        )
        output = _codex_completion_output(item)
        return (
            NormalizedEvent(
                _stream_position(position), event_id, "__tool_result__", {}, output
            ),
        )
    if kind not in {
        "function_call",
        "tool_call",
        "resource_read",
        "resource",
        "command_execution",
        "file_change",
        "mcp_tool_call",
    }:
        return ()
    name = item.get("name") or item.get("tool_name") or item.get("tool") or kind
    if kind == "command_execution":
        name = "exec_command"
    elif kind == "file_change":
        name = "file_change"
    if not isinstance(name, str):
        return ()
    arguments = _codex_input(item, kind)
    tool_input = _decode_arguments(arguments)
    event_id = _string_value(
        item.get("id", item.get("call_id", record.get("id"))), f"line-{position}"
    )
    output = _codex_output(item, record)
    return (
        NormalizedEvent(_stream_position(position), event_id, name, tool_input, output),
    )


def _codex_input(item: dict[str, object], kind: object) -> object:
    if "arguments" in item:
        return item["arguments"]
    if "input" in item:
        return item["input"]
    if "resource" in item:
        return item["resource"]
    if kind in {"resource_read", "resource"}:
        return {
            key: item[key]
            for key in ("uri", "path", "file_path")
            if key in item
        }
    if kind == "file_change":
        return {"changes": item.get("changes", ())}
    return {"command": item.get("command")}


def _codex_output(item: dict[str, object], record: dict[str, object]) -> object:
    output = item.get("output", item.get("aggregated_output", record.get("output")))
    status = item.get("status", record.get("status"))
    exit_code = item.get("exit_code", record.get("exit_code"))
    normalized: dict[str, object] = {}
    if isinstance(exit_code, int) and not isinstance(exit_code, bool):
        normalized["exit_code"] = exit_code
    if output is not None:
        normalized["output"] = output
    if status is not None:
        normalized["status"] = status
    return normalized or output


def _codex_completion_output(item: dict[str, object]) -> object:
    output = item.get("output", item.get("content"))
    status = item.get("status")
    if status is None:
        return output
    return {"status": status, "output": output}


def _decode_arguments(arguments: object) -> object:
    if not isinstance(arguments, str):
        return arguments
    try:
        decoded: object = json.loads(arguments)
    except json.JSONDecodeError:
        return {"command": arguments}
    return decoded


def _accepted_skill_events(
    host: Host, events: tuple[NormalizedEvent, ...]
) -> tuple[Evidence, ...]:
    results = _tool_results(events)
    evidence: list[Evidence] = []
    for event in events:
        completion: NormalizedEvent | None = None
        if host is Host.CLAUDE:
            completion = _claude_skill_completion(event, results)
        elif host is Host.CODEX:
            completion = _codex_skill_completion(event, results)
        if completion is None:
            continue
        if host is Host.CLAUDE:
            evidence.append(
                Evidence(
                    completion.position,
                    event.event_id,
                    "claude-skill",
                    _TARGET_SKILL,
                )
            )
        else:
            evidence.append(
                Evidence(
                    completion.position,
                    event.event_id,
                    "codex-skill-read",
                    _TARGET_SKILL_FILE,
                )
            )
    return tuple(evidence)


def _tool_results(events: tuple[NormalizedEvent, ...]) -> dict[str, NormalizedEvent]:
    results: dict[str, NormalizedEvent] = {}
    for event in events:
        if event.tool_name == "__tool_result__":
            results[event.event_id] = event
    return results


def _claude_skill_completion(
    event: NormalizedEvent, results: dict[str, NormalizedEvent]
) -> NormalizedEvent | None:
    if event.tool_name.lower() != "skill":
        return None
    input_mapping = _as_mapping(event.input)
    if input_mapping is None or input_mapping.get("skill") != _TARGET_SKILL:
        return None
    return _successful_completion(event, results)


def _codex_skill_completion(
    event: NormalizedEvent, results: dict[str, NormalizedEvent]
) -> NormalizedEvent | None:
    input_mapping = _as_mapping(event.input)
    if input_mapping is None:
        return None
    names_target = input_mapping.get("skill") == _TARGET_SKILL or any(
        _TARGET_SKILL_FILE in detail for detail in _strings_in(input_mapping)
    )
    return _successful_completion(event, results) if names_target else None


def _successful_completion(
    event: NormalizedEvent, results: dict[str, NormalizedEvent]
) -> NormalizedEvent | None:
    completion = results.get(event.event_id)
    if completion is None and event.output is not None:
        completion = event
    if completion is None:
        return None
    result_mapping = _as_mapping(completion.output)
    if result_mapping is None:
        return completion
    if result_mapping.get("is_error") is True or result_mapping.get("success") is False:
        return None
    status = result_mapping.get("status")
    if isinstance(status, str):
        return (
            completion
            if status.lower() in {"completed", "success", "succeeded", "ok"}
            else None
        )
    exit_code = result_mapping.get("exit_code")
    if isinstance(exit_code, int) and not isinstance(exit_code, bool):
        return completion if exit_code == 0 else None
    return completion if result_mapping else None


def _host_skill_events_observable(host: Host, events: tuple[NormalizedEvent, ...]) -> bool:
    if host is Host.CLAUDE:
        return True
    for event in events:
        name = event.tool_name.lower()
        if "resource" in name or "skill" in name:
            return True
    return False


def _source_tool_targets_python(name: str, tool_input: dict[str, object]) -> bool:
    if name in {"apply_patch", "patch"}:
        patch = tool_input.get("patch")
        return isinstance(patch, str) and _PYTHON_FILE.search(patch) is not None
    if name == "file_change":
        changes = tool_input.get("changes")
        if not isinstance(changes, list):
            return False
        return any(
            isinstance(change, dict)
            and change.get("kind") not in {"delete", "deleted"}
            and isinstance(change.get("path"), str)
            and str(change["path"]).lower().endswith(".py")
            for change in changes
        )
    for key in ("path", "file_path", "filename"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.lower().endswith(".py"):
            return True
    return False


def _command_constructs_or_executes_python(command: str) -> bool:
    if _writes_python_file(command):
        return True
    return any(_segment_starts_python(segment) for segment in _shell_segments(command))


def _writes_python_file(command: str) -> bool:
    return _redirected_python_path(command) is not None


def _redirected_python_path(command: str) -> str | None:
    tokens = _shell_operator_tokens(command)
    for index, token in enumerate(tokens[:-1]):
        if token in {">", ">>"} and tokens[index + 1].lower().endswith(".py"):
            return tokens[index + 1]
    return None


def _shell_operator_tokens(command: str) -> tuple[str, ...]:
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars="><")
        lexer.whitespace_split = True
        lexer.commenters = ""
        return tuple(lexer)
    except ValueError:
        return ()


def _shell_segments(command: str) -> tuple[str, ...]:
    return tuple(segment.strip() for segment in re.split(r"&&|\|\||[;|]", command) if segment.strip())


def _segment_starts_python(segment: str) -> bool:
    try:
        tokens = shlex.split(segment, posix=True)
    except ValueError:
        return _PYTHON_INTERPRETER.search(segment.strip()) is not None
    return _python_token_index(tokens) is not None


def _after_env(tokens: list[str], index: int) -> int:
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            return index + 1
        if token.startswith("-") or _is_assignment(token):
            index += 1
            continue
        return index
    return index


def _is_assignment(token: str) -> bool:
    return "=" in token and not token.startswith("=")


def _capture_sources(
    events: tuple[NormalizedEvent, ...],
) -> tuple[tuple[CapturedSource, ...], bool]:
    sources: list[CapturedSource] = []
    unresolved_edits: set[str] = set()
    complete_paths: set[str] = set()
    for event in events:
        input_mapping = _as_mapping(event.input)
        if input_mapping is None:
            continue
        name = event.tool_name.lower()
        if name in {"write", "write_file"}:
            source = input_mapping.get("content")
            path = _source_path(input_mapping)
            if isinstance(source, str) and path is not None:
                sources.append(CapturedSource(event.position, event.event_id, source, "write", path))
                complete_paths.add(path)
        elif name in {"edit", "edit_file"}:
            path = _source_path(input_mapping)
            if path is not None:
                unresolved_edits.add(path)
        elif name in {"apply_patch", "patch"}:
            patch = input_mapping.get("patch")
            if isinstance(patch, str):
                for path, source in _added_patch_sources(patch):
                    sources.append(
                        CapturedSource(event.position, event.event_id, source, "patch", path)
                    )
                    complete_paths.add(path)
                unresolved_edits.update(_unreconstructable_patch_paths(patch))
        elif name == "file_change":
            changes = input_mapping.get("changes")
            if isinstance(changes, list):
                unresolved_edits.update(
                    str(change["path"])
                    for change in changes
                    if isinstance(change, dict)
                    and change.get("kind") not in {"delete", "deleted"}
                    and isinstance(change.get("path"), str)
                    and str(change["path"]).lower().endswith(".py")
                )
        elif name == "__source_snapshot__":
            source = input_mapping.get("content")
            path = _source_path(input_mapping)
            if isinstance(source, str) and path is not None:
                sources.append(
                    CapturedSource(event.position, event.event_id, source, "snapshot", path)
                )
                complete_paths.add(path)

        command = _command_from_input(input_mapping)
        if command is None:
            continue
        for path, source in _heredoc_sources(command):
            sources.append(CapturedSource(event.position, event.event_id, source, "heredoc", path))
            if path is not None:
                complete_paths.add(path)
        for source in _python_c_sources(command):
            sources.append(CapturedSource(event.position, event.event_id, source, "python-c"))

    return tuple(sources), not bool(unresolved_edits - complete_paths)


def _source_path(tool_input: dict[str, object]) -> str | None:
    for key in ("path", "file_path", "filename"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.lower().endswith(".py"):
            return value
    return None


def _added_patch_sources(patch: str) -> tuple[tuple[str, str], ...]:
    if "*** Add File: " in patch:
        return _added_apply_patch_sources(patch)

    sources: list[tuple[str, str]] = []
    current_path: str | None = None
    added_lines: list[str] = []
    new_file = False
    old_path_was_dev_null = False
    for line in patch.splitlines():
        if line.startswith("diff --git "):
            if current_path is not None:
                sources.append((current_path, "\n".join(added_lines) + "\n"))
            current_path = None
            added_lines = []
            new_file = False
            old_path_was_dev_null = False
            continue
        if line.startswith("new file mode "):
            new_file = True
            continue
        if line == "--- /dev/null":
            old_path_was_dev_null = True
            continue
        if line.startswith("+++ b/"):
            if current_path is not None:
                sources.append((current_path, "\n".join(added_lines) + "\n"))
            candidate = line.removeprefix("+++ b/").strip()
            current_path = (
                candidate
                if candidate.lower().endswith(".py") and (new_file or old_path_was_dev_null)
                else None
            )
            added_lines = []
            continue
        if current_path is not None and line.startswith("+") and not line.startswith("+++"):
            added_lines.append(line[1:])
    if current_path is not None:
        sources.append((current_path, "\n".join(added_lines) + "\n"))
    return tuple(sources)


def _added_apply_patch_sources(patch: str) -> tuple[tuple[str, str], ...]:
    sources: list[tuple[str, str]] = []
    current_path: str | None = None
    added_lines: list[str] = []
    for line in patch.splitlines():
        if line.startswith("*** Add File: "):
            if current_path is not None:
                sources.append((current_path, "\n".join(added_lines) + "\n"))
            candidate = line.removeprefix("*** Add File: ").strip()
            current_path = candidate if candidate.lower().endswith(".py") else None
            added_lines = []
            continue
        if current_path is not None and line.startswith("+"):
            added_lines.append(line[1:])
    if current_path is not None:
        sources.append((current_path, "\n".join(added_lines) + "\n"))
    return tuple(sources)


def _unreconstructable_patch_paths(patch: str) -> set[str]:
    reconstructed = {path for path, _source in _added_patch_sources(patch)}
    paths: set[str] = set()
    for line in patch.splitlines():
        if line.startswith("*** Update File: "):
            candidate = line.removeprefix("*** Update File: ").strip()
        elif line.startswith("+++ b/"):
            candidate = line.removeprefix("+++ b/").strip()
        else:
            continue
        if candidate.lower().endswith(".py") and candidate not in reconstructed:
            paths.add(candidate)
    return paths


def _heredoc_sources(command: str) -> tuple[tuple[str | None, str], ...]:
    header, separator, remainder = command.partition("\n")
    if not separator:
        return ()
    delimiter_match = re.search(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?", header)
    if delimiter_match is None:
        return ()
    path = _redirected_python_path(header)
    is_python_stdin = _segment_starts_python(header)
    if path is None and not is_python_stdin:
        return ()
    delimiter = delimiter_match.group(1)
    body_lines: list[str] = []
    for line in remainder.splitlines():
        if line.lstrip("\t") == delimiter:
            return ((path, "\n".join(body_lines) + "\n"),)
        body_lines.append(line)
    return ()


def _python_c_sources(command: str) -> tuple[str, ...]:
    sources: list[str] = []
    for segment in _shell_segments(command):
        try:
            tokens = shlex.split(segment, posix=True)
        except ValueError:
            continue
        index = _python_token_index(tokens)
        if index is None:
            continue
        for argument_index, token in enumerate(tokens[index + 1 :], index + 1):
            if token == "-c" and argument_index + 1 < len(tokens):
                sources.append(tokens[argument_index + 1])
                break
    return tuple(sources)


def _python_token_index(tokens: list[str]) -> int | None:
    if not tokens:
        return None
    index = 0
    while index < len(tokens) and _is_assignment(tokens[index]):
        index += 1
    if index < len(tokens) and tokens[index] == "env":
        index = _after_env(tokens, index + 1)
    if index + 1 < len(tokens) and (tokens[index], tokens[index + 1]) in _RUNNER_PREFIXES:
        index += 2
    if index < len(tokens) and _PYTHON_INTERPRETER.fullmatch(tokens[index]) is not None:
        return index
    return None


def _stream_position(line_number: int, content_index: int = 0) -> int:
    return line_number * _POSITION_SCALE + content_index


def _command_from_input(tool_input: object) -> str | None:
    mapping = _as_mapping(tool_input)
    if mapping is None:
        return None
    for key in ("command", "cmd", "script"):
        value = mapping.get(key)
        if isinstance(value, str):
            return value
    return None


def _as_mapping(value: object) -> dict[str, object] | None:
    return value if isinstance(value, dict) else None


def _string_value(value: object, fallback: str) -> str:
    return value if isinstance(value, str) else fallback


def _strings_in(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,)
    if isinstance(value, dict):
        return tuple(item for nested in value.values() for item in _strings_in(nested))
    if isinstance(value, list):
        return tuple(item for nested in value for item in _strings_in(nested))
    return ()
