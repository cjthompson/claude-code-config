"""Independent parser and oracle for incidental-helper fixture results."""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction
import json
from pathlib import Path


SCHEMA_VERSION = 1
_OUTCOMES = frozenset(("passed", "failed", "skipped"))


class InputError(ValueError):
    """The fixture violates the input schema."""


@dataclass(frozen=True)
class ReportRecord:
    nodeid: str
    owner: str
    passed: int
    failed: int
    skipped: int
    failure_percentage: str


def build_report(agent_workspace: Path) -> tuple[ReportRecord, ...]:
    """Parse the fixture and return only flaky-test records in report order."""
    owners = _read_owners(agent_workspace / "owners.json")
    outcomes_by_nodeid: dict[str, Counter[str]] = {}
    seen_run_ids: set[str] = set()
    artifact_paths = sorted((agent_workspace / "artifacts").glob("run-*.json"))
    for path in artifact_paths:
        run_id, tests = _read_artifact(path)
        if run_id in seen_run_ids:
            raise InputError(f"duplicate run_id: {run_id}")
        seen_run_ids.add(run_id)
        for nodeid, outcome in tests:
            outcomes_by_nodeid.setdefault(nodeid, Counter())[outcome] += 1

    records: list[ReportRecord] = []
    for nodeid, outcomes in outcomes_by_nodeid.items():
        passed = outcomes["passed"]
        failed = outcomes["failed"]
        if not (passed and failed):
            continue
        skipped = outcomes["skipped"]
        records.append(
            ReportRecord(
                nodeid=nodeid,
                owner=owners.get(nodeid, "UNOWNED"),
                passed=passed,
                failed=failed,
                skipped=skipped,
                failure_percentage=_format_percentage(failed, passed + failed),
            )
        )
    return tuple(
        sorted(
            records,
            key=lambda record: (
                -Fraction(record.failed, record.passed + record.failed),
                record.nodeid,
            ),
        )
    )


def write_report(agent_workspace: Path, destination: Path) -> None:
    """Write the independent oracle result as canonical UTF-8 JSON."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(
            [asdict(record) for record in build_report(agent_workspace)],
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def _read_owners(path: Path) -> dict[str, str]:
    owners = _read_json(path, "owners")
    if not isinstance(owners, dict):
        raise InputError("owners must be an object")
    if not all(isinstance(nodeid, str) and isinstance(owner, str) for nodeid, owner in owners.items()):
        raise InputError("owners must map node IDs to owner strings")
    return owners


def _read_artifact(path: Path) -> tuple[str, list[tuple[str, str]]]:
    artifact = _read_json(path, "artifact")
    if not isinstance(artifact, dict):
        raise InputError("artifact must be an object")
    expected_run_id = path.stem
    run_id = artifact.get("run_id")
    if not isinstance(run_id, str) or run_id != expected_run_id:
        raise InputError(f"run_id must match filename {expected_run_id}")
    schema_version = artifact.get("schema_version")
    if type(schema_version) is not int or schema_version != SCHEMA_VERSION:
        raise InputError(f"schema_version must be {SCHEMA_VERSION}")
    tests = artifact.get("tests")
    if not isinstance(tests, list):
        raise InputError("artifact tests must be an array")

    seen_nodeids: set[str] = set()
    effective: list[tuple[str, str]] = []
    for test in tests:
        if not isinstance(test, dict):
            raise InputError("test must be an object")
        nodeid = test.get("nodeid")
        if not isinstance(nodeid, str):
            raise InputError("nodeid must be a string")
        if nodeid in seen_nodeids:
            raise InputError(f"duplicate nodeid in {run_id}: {nodeid}")
        seen_nodeids.add(nodeid)
        effective.append((nodeid, _effective_outcome(test.get("attempts"))))
    return run_id, effective


def _effective_outcome(attempts: object) -> str:
    if not isinstance(attempts, list) or not attempts:
        raise InputError("attempts must be a non-empty array")
    seen_numbers: set[int] = set()
    greatest_number = 0
    greatest_outcome = ""
    for attempt in attempts:
        if not isinstance(attempt, dict):
            raise InputError("attempt must be an object")
        number = attempt.get("attempt")
        if type(number) is not int or number <= 0:
            raise InputError("attempt must be a positive integer")
        if number in seen_numbers:
            raise InputError(f"duplicate attempt number: {number}")
        seen_numbers.add(number)
        outcome = attempt.get("outcome")
        if not isinstance(outcome, str) or outcome not in _OUTCOMES:
            raise InputError("attempt outcome must be passed, failed, or skipped")
        if number > greatest_number:
            greatest_number = number
            greatest_outcome = outcome
    return greatest_outcome


def _format_percentage(failed: int, denominator: int) -> str:
    value = (Decimal(failed) * Decimal(100)) / Decimal(denominator)
    return format(value.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP), "f")


def _read_json(path: Path, description: str) -> object:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise InputError(f"invalid {description} JSON: {error}") from error
