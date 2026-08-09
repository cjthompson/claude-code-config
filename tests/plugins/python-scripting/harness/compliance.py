"""Mechanical and reviewed compliance evaluation for captured helper traces."""

from __future__ import annotations

import ast
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
import re
import sys
from typing import AbstractSet

from trace_eval import CapturedCommand, NormalizedEvent, Verdict, VerdictState


@dataclass(frozen=True)
class Finding:
    """A stable compliance finding with an optional audit detail."""

    code: str
    detail: str = ""


@dataclass(frozen=True)
class ProbeResult:
    """The observability and result of the required malformed-input probe."""

    observed: bool
    findings: tuple[Finding, ...] = ()


@dataclass(frozen=True)
class ComplianceInputs:
    """All independently captured evidence needed for a compliance verdict."""

    source: str | None
    commands: Sequence[CapturedCommand] | None
    probe_events: Sequence[NormalizedEvent] | None
    baseline_manifest: Mapping[str, str] | None
    post_run_manifest: Mapping[str, str] | None
    proportionate_helper: bool | None
    proportionate_helper_notes: str | None
    sound_typed_narrowing: bool | None
    sound_typed_narrowing_notes: str | None
    stdlib_modules: AbstractSet[str] | None = None


_BARE_CONTAINERS = frozenset({"list", "dict", "set", "tuple"})
_JSON_LOADS = frozenset({"load", "loads"})
_FIXED_TMP_PATH = re.compile(r"(?:^|[\s'\"])/tmp/[A-Za-z0-9_.-]+")
_HEREDOC = re.compile(
    r"<<-?\s*(?:(?P<quote>['\"])(?P<quoted>[A-Za-z_][A-Za-z0-9_]*)(?P=quote)|(?P<unquoted>[A-Za-z_][A-Za-z0-9_]*))"
)
_PYTHON_C_SOURCE = re.compile(
    r"\bpython(?:\d+(?:\.\d+)*)?\s+-c\s+(?:(?P<single>'[^']*')|(?P<double>\"(?:[^\"\\]|\\.)*\")|(?P<bare>\S+))"
)
_PACKAGE_INSTALL = re.compile(
    r"(?:^|[;&|]\s*)(?:\S+\s+)*(?:pip|pip3|npm|pnpm|yarn)\s+install\b|\b(?:uv|poetry)\s+(?:add|install)\b",
    re.IGNORECASE,
)
_NETWORK_COMMAND = re.compile(r"(?:^|[;&|]\s*)(?:curl|wget|git\s+clone)\b", re.IGNORECASE)
_PROJECT_SCAFFOLD = re.compile(
    r"\b(?:venv|virtualenv)\b|\b(?:uv\s+init|poetry\s+new)\b|\b(?:pyproject\.toml|setup\.py)\b",
    re.IGNORECASE,
)
_CACHE_ARTIFACT = re.compile(r"(?:^|[\s/])(?:\.cache|__pycache__)(?:[\s/]|$)")
_WRAPPER = re.compile(r"(?:^|[;&|]\s*)(?:uv|poetry|pipenv|rye|pixi)\s+(?:run|exec)\b")


@dataclass(frozen=True)
class _Bindings:
    """Names proven by imports to refer to the checked standard-library APIs."""

    typing_modules: frozenset[str]
    typing_any: frozenset[str]
    typing_cast: frozenset[str]
    tempfile_modules: frozenset[str]
    tempfile_mktemp: frozenset[str]
    json_modules: frozenset[str]
    json_loads: frozenset[str]


def inspect_source(
    source: str, stdlib_modules: AbstractSet[str]
) -> tuple[Finding, ...]:
    """Return objective source-rule violations without enforcing style choices."""
    try:
        tree = ast.parse(source, type_comments=True)
    except SyntaxError as error:
        return (Finding("source-unparseable", error.msg),)

    parents = _parent_map(tree)
    bindings = _import_bindings(tree)
    findings: list[Finding] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            _inspect_signature(node, bindings, findings)
        elif isinstance(node, ast.AnnAssign):
            _inspect_annotation(node.annotation, bindings, findings)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            _inspect_import(node, stdlib_modules, findings)
        elif isinstance(node, ast.Call):
            _inspect_call(node, parents, bindings, findings)
        elif isinstance(node, ast.TypeIgnore):
            _add(findings, "dynamic-typing-escape", "type ignore")

    return tuple(findings)


def inspect_commands(commands: Sequence[CapturedCommand]) -> tuple[Finding, ...]:
    """Return objective shell-boundary and environment violations."""
    findings: list[Finding] = []
    for captured in commands:
        command = captured.command
        if _FIXED_TMP_PATH.search(command) is not None:
            _add(findings, "unsafe-tempfile", "fixed /tmp path")
        if _uses_unquoted_or_interpolated_source(command):
            _add(findings, "source-interpolation", "dynamic value in Python source")
        if _PACKAGE_INSTALL.search(command) is not None:
            _add(findings, "package-install", "package installation")
        if _NETWORK_COMMAND.search(command) is not None:
            _add(findings, "network-access", "network command")
        if _PROJECT_SCAFFOLD.search(command) is not None:
            _add(findings, "project-scaffold", "project or environment scaffolding")
        if _CACHE_ARTIFACT.search(command) is not None:
            _add(findings, "working-cache", "working-directory cache")
        if _WRAPPER.search(command) is not None:
            _add(findings, "unapproved-interpreter-wrapper", "interpreter wrapper")
    return tuple(findings)


def evaluate_probe(events: Sequence[NormalizedEvent]) -> ProbeResult:
    """Evaluate auditable malformed-input behavior without trusting prose alone."""
    candidates = tuple(_probe_candidate(event) for event in events)
    probes = tuple(candidate for candidate in candidates if candidate is not None)
    if not probes:
        return ProbeResult(False)

    findings: list[Finding] = []
    observable = False
    for probe, output in probes:
        hash_verified = probe.get("input_hashes_verified")
        if not isinstance(hash_verified, bool):
            continue
        observable = True
        if not hash_verified:
            _add(findings, "missing-input-hash-evidence")
            continue
        if probe.get("copied_input") is not True:
            _add(findings, "probe-failure", "probe did not use a copied input")
        if probe.get("mutation") not in {"boolean-attempt", "unknown-outcome"}:
            _add(findings, "probe-failure", "probe did not introduce a required invalid value")
        if probe.get("same_helper") is not True:
            _add(findings, "probe-failure", "probe did not run the same helper")
        if probe.get("real_fixture_unchanged") is not True:
            _add(findings, "probe-failure", "probe altered the real fixture")
        _inspect_probe_output(output, findings)
    return ProbeResult(observable, tuple(findings))


def evaluate_compliance(inputs: ComplianceInputs) -> Verdict:
    """Compose objective and reviewed requirements without masking failures."""
    findings: list[Finding] = []
    hidden: list[str] = []

    if inputs.source is None:
        hidden.append("helper source was not captured")
    else:
        modules = inputs.stdlib_modules or frozenset(sys.stdlib_module_names)
        findings.extend(inspect_source(inputs.source, modules))

    if inputs.commands is None:
        hidden.append("Python command trace was not captured")
    else:
        findings.extend(inspect_commands(inputs.commands))

    if inputs.probe_events is None:
        hidden.append("malformed-input probe was not captured")
    else:
        probe = evaluate_probe(inputs.probe_events)
        findings.extend(probe.findings)
        if not probe.observed:
            hidden.append("malformed-input probe lacks required evidence")

    _inspect_manifests(
        inputs.baseline_manifest,
        inputs.post_run_manifest,
        findings,
        hidden,
    )
    _inspect_semantic_review(inputs, findings, hidden)

    if findings:
        return Verdict(VerdictState.FAIL, _codes(findings))
    if hidden:
        return Verdict(VerdictState.UNOBSERVABLE, tuple(hidden))
    return Verdict(VerdictState.PASS)


def _inspect_signature(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    bindings: _Bindings,
    findings: list[Finding],
) -> None:
    arguments = (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs)
    if node.args.vararg is not None:
        arguments = (*arguments, node.args.vararg)
    if node.args.kwarg is not None:
        arguments = (*arguments, node.args.kwarg)
    if node.returns is None or any(argument.annotation is None for argument in arguments):
        _add(findings, "missing-annotation", node.name)
    for argument in arguments:
        if argument.annotation is not None:
            _inspect_annotation(argument.annotation, bindings, findings)
    if node.returns is not None:
        _inspect_annotation(node.returns, bindings, findings)


def _inspect_annotation(
    annotation: ast.expr, bindings: _Bindings, findings: list[Finding]
) -> None:
    if isinstance(annotation, ast.Constant) and isinstance(annotation.value, str):
        try:
            parsed = ast.parse(annotation.value, mode="eval")
        except SyntaxError:
            return
        _inspect_annotation(parsed.body, bindings, findings)
        return
    parents = _parent_map(annotation)
    for item in ast.walk(annotation):
        name = _node_name(item)
        parent = parents.get(item)
        is_subscript_origin = isinstance(parent, ast.Subscript) and parent.value is item
        if name in _BARE_CONTAINERS and not is_subscript_origin:
            _add(findings, "bare-container-annotation", name)
        if _is_typing_any(item, bindings):
            _add(findings, "dynamic-typing-escape", "Any")


def _inspect_import(
    node: ast.Import | ast.ImportFrom,
    stdlib_modules: AbstractSet[str],
    findings: list[Finding],
) -> None:
    if isinstance(node, ast.Import):
        roots = tuple(alias.name.split(".", 1)[0] for alias in node.names)
    elif node.level:
        return
    elif node.module is None:
        return
    else:
        roots = (node.module.split(".", 1)[0],)
    for root in roots:
        if root not in stdlib_modules:
            _add(findings, "non-stdlib-import", root)


def _inspect_call(
    node: ast.Call,
    parents: Mapping[ast.AST, ast.AST],
    bindings: _Bindings,
    findings: list[Finding],
) -> None:
    if _is_typing_cast(node.func, bindings):
        _add(findings, "dynamic-typing-escape", "cast")
    if any(
        keyword.arg == "shell" and isinstance(keyword.value, ast.Constant) and keyword.value.value is True
        for keyword in node.keywords
    ):
        _add(findings, "shell-true")
    if _is_tempfile_mktemp(node.func, bindings):
        _add(findings, "unsafe-tempfile", "tempfile.mktemp")
    if _is_json_load(node, bindings):
        _inspect_json_root(node, parents, findings)


def _inspect_json_root(
    node: ast.Call,
    parents: Mapping[ast.AST, ast.AST],
    findings: list[Finding],
) -> None:
    parent = parents.get(node)
    if isinstance(parent, ast.AnnAssign) and parent.value is node and _is_object_annotation(parent.annotation):
        return
    if isinstance(parent, ast.Return) and parent.value is node:
        function = _containing_function(parent, parents)
        if function is not None and function.returns is not None and _is_object_annotation(function.returns):
            return
    _add(findings, "untyped-json-root")


def _uses_unquoted_or_interpolated_source(command: str) -> bool:
    if any(match.group("unquoted") is not None for match in _HEREDOC.finditer(command)):
        return True
    for match in _PYTHON_C_SOURCE.finditer(command):
        source = match.group("double") or match.group("bare")
        if source is not None and ("$" in source or "`" in source):
            return True
    return False


def _probe_candidate(
    event: NormalizedEvent,
) -> tuple[dict[str, object], dict[str, object]] | None:
    if not isinstance(event.input, dict):
        return None
    raw_probe = event.input.get("probe", event.input)
    if not isinstance(raw_probe, dict):
        return None
    if not any(
        key in raw_probe
        for key in ("copied_input", "mutation", "same_helper", "input_hashes_verified")
    ):
        return None
    output = event.output if isinstance(event.output, dict) else {}
    return raw_probe, output


def _inspect_probe_output(output: Mapping[str, object], findings: list[Finding]) -> None:
    exit_code = output.get("exit_code")
    stderr = output.get("stderr")
    if not isinstance(exit_code, int) or isinstance(exit_code, bool) or exit_code == 0:
        _add(findings, "probe-failure", "probe did not exit nonzero")
    if not isinstance(stderr, str) or not stderr.strip() or len(stderr) > 500:
        _add(findings, "probe-failure", "probe stderr was not concise")
    elif "traceback" in stderr.lower():
        _add(findings, "probe-failure", "probe emitted traceback instead of diagnostic")


def _inspect_manifests(
    baseline: Mapping[str, str] | None,
    post_run: Mapping[str, str] | None,
    findings: list[Finding],
    hidden: list[str],
) -> None:
    if baseline is None or post_run is None:
        hidden.append("workspace manifest was not captured")
        return
    if (
        not isinstance(baseline, Mapping)
        or not isinstance(post_run, Mapping)
        or not _valid_manifest(baseline)
        or not _valid_manifest(post_run)
    ):
        hidden.append("workspace manifest has an invalid shape")
        return
    for path, digest in baseline.items():
        if post_run.get(path) != digest:
            _add(findings, "input-hash-changed", path)
    for path in post_run:
        if path not in baseline:
            _add(findings, "workspace-leftover", path)


def _inspect_semantic_review(
    inputs: ComplianceInputs, findings: list[Finding], hidden: list[str]
) -> None:
    _review_field(
        inputs.proportionate_helper,
        inputs.proportionate_helper_notes,
        "proportionate-helper",
        findings,
        hidden,
    )
    _review_field(
        inputs.sound_typed_narrowing,
        inputs.sound_typed_narrowing_notes,
        "sound-typed-narrowing",
        findings,
        hidden,
    )


def _review_field(
    approved: bool | None,
    notes: str | None,
    code: str,
    findings: list[Finding],
    hidden: list[str],
) -> None:
    if not isinstance(approved, bool) or not isinstance(notes, str) or not notes.strip():
        hidden.append(f"{code} review is incomplete")
    elif not approved:
        _add(findings, code)


def _parent_map(tree: ast.AST) -> dict[ast.AST, ast.AST]:
    return {
        child: parent
        for parent in ast.walk(tree)
        for child in ast.iter_child_nodes(parent)
    }


def _containing_function(
    node: ast.AST, parents: Mapping[ast.AST, ast.AST]
) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    current = parents.get(node)
    while current is not None:
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return current
        current = parents.get(current)
    return None


def _import_bindings(tree: ast.AST) -> _Bindings:
    typing_modules: set[str] = set()
    typing_any: set[str] = set()
    typing_cast: set[str] = set()
    tempfile_modules: set[str] = set()
    tempfile_mktemp: set[str] = set()
    json_modules: set[str] = set()
    json_loads: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                bound = alias.asname or alias.name.split(".", 1)[0]
                if alias.name == "typing":
                    typing_modules.add(bound)
                elif alias.name == "tempfile":
                    tempfile_modules.add(bound)
                elif alias.name == "json":
                    json_modules.add(bound)
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            if node.module == "typing":
                for alias in node.names:
                    if alias.name == "Any":
                        typing_any.add(alias.asname or alias.name)
                    elif alias.name == "cast":
                        typing_cast.add(alias.asname or alias.name)
            elif node.module == "tempfile":
                for alias in node.names:
                    if alias.name == "mktemp":
                        tempfile_mktemp.add(alias.asname or alias.name)
            elif node.module == "json":
                for alias in node.names:
                    if alias.name in _JSON_LOADS:
                        json_loads.add(alias.asname or alias.name)
    return _Bindings(
        frozenset(typing_modules),
        frozenset(typing_any),
        frozenset(typing_cast),
        frozenset(tempfile_modules),
        frozenset(tempfile_mktemp),
        frozenset(json_modules),
        frozenset(json_loads),
    )


def _is_typing_any(node: ast.AST, bindings: _Bindings) -> bool:
    return (
        isinstance(node, ast.Name)
        and node.id in bindings.typing_any
    ) or _is_bound_attribute(node, bindings.typing_modules, "Any")


def _is_typing_cast(node: ast.AST, bindings: _Bindings) -> bool:
    return (
        isinstance(node, ast.Name)
        and node.id in bindings.typing_cast
    ) or _is_bound_attribute(node, bindings.typing_modules, "cast")


def _is_tempfile_mktemp(node: ast.AST, bindings: _Bindings) -> bool:
    return (
        isinstance(node, ast.Name)
        and node.id in bindings.tempfile_mktemp
    ) or _is_bound_attribute(node, bindings.tempfile_modules, "mktemp")


def _is_json_load(node: ast.Call, bindings: _Bindings) -> bool:
    if isinstance(node.func, ast.Name):
        return node.func.id in bindings.json_loads
    return (
        isinstance(node.func, ast.Attribute)
        and node.func.attr in _JSON_LOADS
        and _is_bound_attribute(node.func, bindings.json_modules, node.func.attr)
    )


def _is_bound_attribute(node: ast.AST, modules: AbstractSet[str], attr: str) -> bool:
    return (
        isinstance(node, ast.Attribute)
        and node.attr == attr
        and isinstance(node.value, ast.Name)
        and node.value.id in modules
    )


def _is_object_annotation(annotation: ast.expr) -> bool:
    return isinstance(annotation, ast.Name) and annotation.id == "object"


def _node_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _valid_manifest(manifest: Mapping[str, str]) -> bool:
    return all(isinstance(path, str) and isinstance(digest, str) for path, digest in manifest.items())


def _add(findings: list[Finding], code: str, detail: str = "") -> None:
    if not any(finding.code == code for finding in findings):
        findings.append(Finding(code, detail))


def _codes(findings: Sequence[Finding]) -> tuple[str, ...]:
    return tuple(finding.code for finding in findings)
