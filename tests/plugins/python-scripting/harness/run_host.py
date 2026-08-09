"""Secret-safe subprocess runners for isolated Claude and Codex evaluations."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
from typing import Mapping, Sequence

from prepare_run import RunLayout
from trace_eval import Host


_SUBPROCESS_TIMEOUT = 30
_AGENT_TIMEOUT = 900
_TOOLS = "Read,Glob,Grep,Bash,Write,Edit,Skill"
_PLUGIN_NAME = "python-scripting"
_MARKETPLACE_NAME = "python-scripting-test"
_SECRET_VARIABLES = ("OPENAI_API_KEY", "CODEX_ACCESS_TOKEN")


@dataclass(frozen=True)
class RunValidity:
    """Harness validity, independent of discovery and compliance."""

    state: str
    reasons: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.state not in {"VALID", "INVALID"}:
            raise ValueError(f"unknown validity state: {self.state}")
        if self.state == "VALID" and self.reasons:
            raise ValueError("a valid run cannot have invalidity reasons")
        if self.state == "INVALID" and not self.reasons:
            raise ValueError("an invalid run requires a reason")


@dataclass(frozen=True)
class CompletedRun:
    """Auditable result of host setup, isolation gates, and agent execution."""

    host: Host
    model: str
    validity: RunValidity
    command: tuple[str, ...]
    trace_path: Path
    final_response: str
    cli_version: str
    enabled_plugins: tuple[str, ...]
    start_time: str
    end_time: str
    exit_code: int | None


class _AgentExitError(subprocess.SubprocessError):
    """Preserve a failed agent process status without leaking its stderr."""

    def __init__(self, exit_code: int, message: str) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class _PluginInventoryError(ValueError):
    """Retain an observed plugin inventory that violates the exact allowlist."""

    def __init__(self, plugins: tuple[str, ...], message: str) -> None:
        super().__init__(message)
        self.plugins = plugins


def build_codex_command(layout: RunLayout, model: str) -> tuple[str, ...]:
    """Build the documented strict Codex command with globals before exec."""
    return (
        str(layout.codex_executable),
        "--strict-config",
        "--ask-for-approval",
        "never",
        "-C",
        str(layout.agent_workspace),
        "--model",
        model,
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--json",
        "-",
    )


def build_claude_command(layout: RunLayout, model: str) -> tuple[str, ...]:
    """Build an ephemeral Claude stream-JSON command inside sandbox-exec."""
    return (
        str(layout.sandbox_executable),
        "-f",
        str(layout.claude_sandbox_profile),
        str(layout.claude_executable),
        "-p",
        "--input-format",
        "text",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        "--setting-sources",
        "project,local",
        "--strict-mcp-config",
        "--plugin-dir",
        str(layout.staged_plugin),
        "--no-session-persistence",
        "--permission-mode",
        "dontAsk",
        "--tools",
        _TOOLS,
        "--allowedTools",
        _TOOLS,
    )


def run_host(host: Host, layout: RunLayout, model: str) -> CompletedRun:
    """Run one host without exposing credentials or evaluator state to the agent."""
    started = _timestamp()
    trace_path = layout.evaluator_workspace / f"{host.value}-trace.jsonl"
    trace_path.write_text("", encoding="utf-8")
    command = (
        build_codex_command(layout, model)
        if host is Host.CODEX
        else build_claude_command(layout, model)
    )
    reasons: list[str] = []
    final_response = ""
    cli_version = ""
    enabled_plugins: tuple[str, ...] = ()
    exit_code: int | None = None
    secret_values = tuple(
        value for name in _SECRET_VARIABLES if (value := os.environ.get(name))
    )

    try:
        if host is Host.CODEX:
            (
                cli_version,
                final_response,
                enabled_plugins,
                exit_code,
            ) = _run_codex(layout, model, trace_path, secret_values)
        elif host is Host.CLAUDE:
            environment = _agent_environment(layout, codex=False)
            cli_version = _smoke_claude_isolation(layout, environment)
            reasons.append(
                "Claude parent-only network isolation is unsupported without "
                "a separately sandboxed shell or network broker"
            )
        else:
            reasons.append(f"unsupported host: {host!r}")
    except _AgentExitError as error:
        exit_code = error.exit_code
        reasons.append(_redact(str(error), secret_values))
    except _PluginInventoryError as error:
        enabled_plugins = error.plugins
        reasons.append(str(error))
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        reasons.append(_redact(f"host setup or execution failed: {error}", secret_values))
    finally:
        if host is Host.CODEX:
            _remove_codex_home(layout, reasons)

    try:
        workspace_files, workspace_reasons = _regular_files(layout.agent_workspace)
    except (OSError, ValueError) as error:
        workspace_files = ()
        workspace_reasons = (f"agent workspace scan failed: {error}",)
    reasons.extend(workspace_reasons)
    try:
        reasons.extend(_redact_leaks(layout, secret_values, workspace_files))
    except (OSError, ValueError) as error:
        reasons.append(f"credential leak scan failed: {error}")
    final_response = _redact(final_response, secret_values)
    try:
        post_run_hashes = _hash_regular_files(layout.agent_workspace, workspace_files)
    except (OSError, ValueError) as error:
        post_run_hashes = {}
        reasons.append(f"post-run hash capture failed: {error}")
    _write_json(layout.evaluator_workspace / "post-run-hashes.json", post_run_hashes)
    ended = _timestamp()
    validity = RunValidity("INVALID", tuple(reasons)) if reasons else RunValidity("VALID")
    completed = CompletedRun(
        host=host,
        model=model,
        validity=validity,
        command=command,
        trace_path=trace_path,
        final_response=final_response,
        cli_version=cli_version,
        enabled_plugins=enabled_plugins,
        start_time=started,
        end_time=ended,
        exit_code=exit_code,
    )
    _record_run(layout, completed)
    return completed


def _run_codex(
    layout: RunLayout,
    model: str,
    trace_path: Path,
    secret_values: Sequence[str],
) -> tuple[str, str, tuple[str, ...], int]:
    credentials = [
        (name, os.environ[name])
        for name in _SECRET_VARIABLES
        if os.environ.get(name)
    ]
    if len(credentials) != 1:
        raise ValueError("Codex requires exactly one configured credential variable")
    name, credential = credentials[0]
    environment = _agent_environment(layout, codex=True)
    executable = str(layout.codex_executable)

    version = _checked_capture(
        (executable, "--version"), environment, cwd=layout.agent_workspace
    ).stdout.strip()
    _checked_capture(
        (executable, "plugin", "marketplace", "add", str(layout.staged_marketplace)),
        environment,
        cwd=layout.agent_workspace,
    )
    _checked_capture(
        (executable, "plugin", "add", f"{_PLUGIN_NAME}@{_MARKETPLACE_NAME}"),
        environment,
        cwd=layout.agent_workspace,
    )
    plugin_listing = _checked_capture(
        (executable, "plugin", "list", "--json"),
        environment,
        cwd=layout.agent_workspace,
    )
    enabled_plugins = _parse_codex_plugins(plugin_listing.stdout)
    if enabled_plugins != (_PLUGIN_NAME,):
        raise _PluginInventoryError(
            enabled_plugins,
            "Codex enabled plugin inventory is not exactly python-scripting",
        )
    login_flag = "--with-api-key" if name == "OPENAI_API_KEY" else "--with-access-token"
    _checked_capture(
        (executable, "login", login_flag),
        environment,
        cwd=layout.agent_workspace,
        input_text=credential + "\n",
    )

    doctor = _checked_capture(
        (executable, "--strict-config", "doctor", "--json"),
        environment,
        cwd=layout.agent_workspace,
    )
    _validate_doctor(doctor.stdout)
    full_command = build_codex_command(layout, model)
    exec_index = full_command.index("exec")
    _checked_capture(
        full_command[:exec_index] + ("exec", "--help"),
        environment,
        cwd=layout.agent_workspace,
    )
    result = _run_agent(
        full_command,
        environment,
        layout.read_prompt(),
        trace_path,
        layout.agent_workspace,
    )
    if result.returncode != 0:
        raise _AgentExitError(
            result.returncode,
            _redact(
                f"Codex agent exited {result.returncode}: {result.stderr.strip()}",
                secret_values,
            ),
        )
    records = _read_jsonl(trace_path)
    return version, _codex_final_response(records), enabled_plugins, result.returncode


def _smoke_claude_isolation(
    layout: RunLayout, environment: Mapping[str, str]
) -> str:
    prefix = (
        str(layout.sandbox_executable),
        "-f",
        str(layout.claude_sandbox_profile),
    )
    version = _checked_capture(
        prefix + (str(layout.claude_executable), "--version"),
        environment,
        cwd=layout.agent_workspace,
    ).stdout.strip()
    for allowed in (
        layout.agent_workspace / "owners.json",
        layout.staged_plugin / ".claude-plugin" / "plugin.json",
    ):
        _checked_capture(
            prefix + ("/bin/cat", str(allowed)),
            environment,
            cwd=layout.agent_workspace,
        )

    forbidden_commands = (
        prefix + ("/bin/cat", str(layout.repository_sentinel)),
        prefix + ("/bin/cat", str(layout.evaluator_sentinel)),
        prefix + ("/usr/bin/security", "help"),
    )
    for command in forbidden_commands:
        completed = _capture(
            command,
            environment,
            check=False,
            cwd=layout.agent_workspace,
        )
        if completed.returncode == 0:
            raise ValueError(f"isolation sentinel was readable or executable: {command[-1]}")
    return version


def _validate_doctor(output: str) -> None:
    try:
        value: object = json.loads(output)
    except json.JSONDecodeError as error:
        raise ValueError(f"Codex doctor emitted invalid JSON: {error.msg}") from error
    if not isinstance(value, dict):
        raise ValueError("Codex doctor JSON must be an object")
    config = value.get("config")
    authentication = value.get("authentication")
    permissions = value.get("permissions")
    if not isinstance(config, dict) or config.get("valid") is not True or config.get("strict") is not True:
        raise ValueError("Codex doctor did not validate strict configuration")
    if not isinstance(authentication, dict) or authentication.get("valid") is not True:
        raise ValueError("Codex doctor did not validate authentication")
    if not isinstance(permissions, dict) or permissions.get("profile") != _MARKETPLACE_NAME:
        raise ValueError("Codex doctor did not recognize the permission profile")
    filesystem = permissions.get("filesystem")
    network = permissions.get("network")
    if not isinstance(filesystem, dict) or filesystem.get("workspace_write") is not True:
        raise ValueError("Codex doctor did not recognize workspace-only writes")
    if not isinstance(network, dict) or network.get("enabled") is not False:
        raise ValueError("Codex doctor did not recognize disabled network access")


def _codex_final_response(records: Sequence[dict[str, object]]) -> str:
    responses: list[tuple[int, str]] = []
    terminal_positions: list[int] = []
    for position, record in enumerate(records):
        if record.get("type") == "turn.completed":
            terminal_positions.append(position)
        item = record.get("item")
        if not isinstance(item, dict) or item.get("type") != "agent_message":
            continue
        text = item.get("text", item.get("content"))
        if isinstance(text, str):
            responses.append((position, text))
    if not terminal_positions:
        raise ValueError("Codex trace omitted a successful terminal event")
    terminal = terminal_positions[-1]
    eligible = [text for position, text in responses if position < terminal]
    if not eligible:
        raise ValueError("Codex terminal event has no preceding final response")
    if any(record.get("type") in {"turn.failed", "error"} for record in records[terminal + 1 :]):
        raise ValueError("Codex trace reports failure after its terminal event")
    return eligible[-1]


def _parse_codex_plugins(output: str) -> tuple[str, ...]:
    try:
        raw: object = json.loads(output)
    except json.JSONDecodeError as error:
        raise ValueError(f"Codex plugin list emitted invalid JSON: {error.msg}") from error
    if not isinstance(raw, dict):
        raise ValueError("Codex plugin list JSON is missing plugins")
    inventory = raw.get("installed", raw.get("plugins"))
    if not isinstance(inventory, list):
        raise ValueError("Codex plugin list JSON is missing plugins")
    names: list[str] = []
    for item in inventory:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ValueError("Codex plugin list contains malformed inventory")
        if item.get("enabled") is True:
            names.append(item["name"])
    return tuple(sorted(names))


def _claude_final_response(records: Sequence[dict[str, object]]) -> str:
    responses: list[str] = []
    for record in records:
        result = record.get("result")
        if (
            record.get("type") == "result"
            and record.get("subtype") == "success"
            and record.get("is_error") is not True
            and isinstance(result, str)
        ):
            responses.append(result)
    if not responses:
        raise ValueError("Claude trace omitted a successful terminal result")
    return responses[-1]


def _agent_environment(layout: RunLayout, *, codex: bool) -> dict[str, str]:
    environment = {
        "HOME": str(layout.agent_workspace),
        "LANG": "C.UTF-8",
        "PATH": layout.minimal_path,
        "PYTHONNOUSERSITE": "1",
    }
    if codex:
        environment["CODEX_HOME"] = str(layout.codex_home)
    return environment


def _checked_capture(
    command: Sequence[str],
    environment: Mapping[str, str],
    *,
    cwd: Path,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    return _capture(
        command,
        environment,
        check=True,
        cwd=cwd,
        input_text=input_text,
    )


def _capture(
    command: Sequence[str],
    environment: Mapping[str, str],
    *,
    check: bool,
    cwd: Path,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        tuple(command),
        check=check,
        shell=False,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=_SUBPROCESS_TIMEOUT,
        env=dict(environment),
        cwd=cwd,
    )


def _run_agent(
    command: Sequence[str],
    environment: Mapping[str, str],
    prompt: str,
    trace_path: Path,
    cwd: Path,
) -> subprocess.CompletedProcess[str]:
    with trace_path.open("w", encoding="utf-8") as trace:
        return subprocess.run(
            tuple(command),
            check=False,
            shell=False,
            input=prompt,
            stdout=trace,
            stderr=subprocess.PIPE,
            text=True,
            timeout=_AGENT_TIMEOUT,
            env=dict(environment),
            cwd=cwd,
        )


def _read_jsonl(path: Path) -> tuple[dict[str, object], ...]:
    records: list[dict[str, object]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        try:
            value: object = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"malformed host JSONL at line {line_number}: {error.msg}") from error
        if not isinstance(value, dict):
            raise ValueError(f"malformed host JSONL at line {line_number}: expected object")
        records.append(value)
    if not records:
        raise ValueError("host emitted no JSONL events")
    return tuple(records)


def _remove_codex_home(layout: RunLayout, reasons: list[str]) -> None:
    try:
        resolved = layout.codex_home.resolve()
        if resolved.parent != layout.evaluator_workspace.resolve():
            reasons.append("refused to clean an unexpected Codex home path")
            return
        if resolved.exists():
            shutil.rmtree(resolved)
    except OSError as error:
        reasons.append(f"failed to remove temporary Codex home: {error}")


def _redact_leaks(
    layout: RunLayout,
    secrets: Sequence[str],
    workspace_files: Sequence[Path],
) -> tuple[str, ...]:
    if not secrets:
        return ()
    leaked: list[str] = []
    replacements = tuple(secret.encode("utf-8") for secret in secrets)
    file_groups = ((layout.agent_workspace, workspace_files),)
    trusted_roots = (layout.staged_marketplace, layout.evaluator_workspace)
    file_groups += tuple((root, _regular_files(root)[0]) for root in trusted_roots)
    for root, files in file_groups:
        for path in files:
            relative = path.relative_to(root)
            data = _read_beneath(root, relative)
            redacted = data
            for secret in replacements:
                if secret in redacted:
                    redacted = redacted.replace(secret, b"<redacted>")
            if redacted != data:
                _write_beneath(root, relative, redacted)
                leaked.append(path.relative_to(root).as_posix())
    if not leaked:
        return ()
    return ("credential material was found and redacted from: " + ", ".join(leaked),)


def _regular_files(root: Path) -> tuple[tuple[Path, ...], tuple[str, ...]]:
    files: list[Path] = []
    reasons: list[str] = []
    directory_flags = (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        root_descriptor = os.open(root, directory_flags)
    except OSError as error:
        try:
            root_mode = root.lstat().st_mode
        except OSError:
            return (), (f"agent workspace root is unavailable: {error}",)
        if stat.S_ISLNK(root_mode):
            return (), ("agent workspace root is a symlink",)
        return (), (f"agent workspace root is not a safe directory: {error}",)

    def walk(directory_descriptor: int, relative: Path) -> None:
        for name in sorted(os.listdir(directory_descriptor)):
            child_relative = relative / name
            try:
                item = os.stat(
                    name,
                    dir_fd=directory_descriptor,
                    follow_symlinks=False,
                )
            except OSError as error:
                reasons.append(
                    f"agent workspace entry changed during scan: {child_relative.as_posix()}: {error}"
                )
                continue
            if stat.S_ISREG(item.st_mode):
                files.append(root / child_relative)
                continue
            if stat.S_ISDIR(item.st_mode):
                try:
                    child_descriptor = os.open(
                        name,
                        directory_flags,
                        dir_fd=directory_descriptor,
                    )
                except OSError as error:
                    reasons.append(
                        f"agent workspace directory changed during scan: {child_relative.as_posix()}: {error}"
                    )
                    continue
                try:
                    walk(child_descriptor, child_relative)
                finally:
                    os.close(child_descriptor)
                continue
            kind = "symlink" if stat.S_ISLNK(item.st_mode) else "non-regular file"
            reasons.append(
                f"agent workspace contains {kind}: {child_relative.as_posix()}"
            )

    try:
        walk(root_descriptor, Path())
    finally:
        os.close(root_descriptor)
    return tuple(sorted(files)), tuple(reasons)


def _open_beneath(root: Path, relative: Path, flags: int) -> int:
    if relative.is_absolute() or not relative.parts or any(
        part in {"", ".", ".."} for part in relative.parts
    ):
        raise ValueError(f"unsafe relative path: {relative}")
    directory_flags = (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    descriptors: list[int] = [os.open(root, directory_flags)]
    try:
        for part in relative.parts[:-1]:
            descriptors.append(
                os.open(
                    part,
                    directory_flags,
                    dir_fd=descriptors[-1],
                )
            )
        return os.open(
            relative.parts[-1],
            flags | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=descriptors[-1],
        )
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _read_beneath(root: Path, relative: Path) -> bytes:
    descriptor = _open_beneath(root, relative, os.O_RDONLY)
    with os.fdopen(descriptor, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError(f"refused to read non-regular file: {relative}")
        return handle.read()


def _write_beneath(root: Path, relative: Path, data: bytes) -> None:
    descriptor = _open_beneath(root, relative, os.O_WRONLY | os.O_TRUNC)
    with os.fdopen(descriptor, "wb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError(f"refused to write non-regular file: {relative}")
        handle.write(data)


def _read_regular_file(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError(f"refused to read non-regular file: {path}")
        return handle.read()


def _write_regular_file(path: Path, data: bytes) -> None:
    flags = os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "wb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError(f"refused to write non-regular file: {path}")
        handle.write(data)


def _hash_regular_files(root: Path, files: Sequence[Path]) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(
            _read_beneath(root, path.relative_to(root))
        ).hexdigest()
        for path in files
    }


def _record_run(layout: RunLayout, completed: CompletedRun) -> None:
    existing: object = json.loads(layout.metadata_path.read_text(encoding="utf-8"))
    metadata = existing if isinstance(existing, dict) else {}
    metadata.update(
        {
            "cli_version": completed.cli_version,
            "command": list(completed.command),
            "enabled_plugins": list(completed.enabled_plugins),
            "end_time": completed.end_time,
            "exit_code": completed.exit_code,
            "final_response_sha256": _text_sha256(completed.final_response),
            "host": completed.host.value,
            "model": completed.model,
            "start_time": completed.start_time,
            "validity": {
                "reasons": list(completed.validity.reasons),
                "state": completed.validity.state,
            },
        }
    )
    _write_json(layout.metadata_path, metadata)
    trace_sha256 = hashlib.sha256(completed.trace_path.read_bytes()).hexdigest()
    final_response_sha256 = _text_sha256(completed.final_response)
    post_run_hashes_path = layout.evaluator_workspace / "post-run-hashes.json"
    post_run_hashes_sha256 = hashlib.sha256(post_run_hashes_path.read_bytes()).hexdigest()
    post_run_hashes: object = json.loads(post_run_hashes_path.read_text(encoding="utf-8"))
    if not isinstance(post_run_hashes, dict):
        post_run_hashes = {}
    host_evidence_path = layout.evaluator_workspace / "host-evidence.json"
    _write_json(
        host_evidence_path,
        {
            "baseline_hashes_sha256": layout.baseline_hashes_sha256,
            "final_response_sha256": final_response_sha256,
            "host": completed.host.value,
            "metadata_sha256": hashlib.sha256(layout.metadata_path.read_bytes()).hexdigest(),
            "post_run_hashes_sha256": post_run_hashes_sha256,
            "post_run_tree_sha256": _mapping_sha256(post_run_hashes),
            "pre_run_tree_sha256": _mapping_sha256(layout.pre_run_hashes),
            "trace_path": completed.trace_path.relative_to(
                layout.evaluator_workspace
            ).as_posix(),
            "trace_sha256": trace_sha256,
        },
    )
    _write_json(
        layout.evaluator_workspace / "run-status.json",
        {
            "host": completed.host.value,
            "reasons": list(completed.validity.reasons),
            "state": completed.validity.state,
            "trace_path": completed.trace_path.relative_to(
                layout.evaluator_workspace
            ).as_posix(),
            "trace_sha256": trace_sha256,
            "final_response_sha256": final_response_sha256,
            "host_evidence_sha256": hashlib.sha256(
                host_evidence_path.read_bytes()
            ).hexdigest(),
        },
    )


def _write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _redact(text: str, secrets: Sequence[str]) -> str:
    result = text
    for secret in secrets:
        result = result.replace(secret, "<redacted>")
    return result


def _text_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _mapping_sha256(value: Mapping[str, object]) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()
