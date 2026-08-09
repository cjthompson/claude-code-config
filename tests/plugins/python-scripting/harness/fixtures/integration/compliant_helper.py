from __future__ import annotations

from dataclasses import asdict, dataclass
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction
import json
from pathlib import Path
import sys


OUTCOMES = frozenset(("passed", "failed", "skipped"))


class InputError(ValueError):
    pass


@dataclass(frozen=True)
class Counts:
    passed: int = 0
    failed: int = 0
    skipped: int = 0


@dataclass(frozen=True)
class Row:
    nodeid: str
    owner: str
    passed: int
    failed: int
    skipped: int
    failure_percentage: str


def read_json(path: Path) -> object:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def read_owners(path: Path) -> dict[str, str]:
    raw: object = read_json(path)
    if not isinstance(raw, dict) or not all(
        isinstance(nodeid, str) and isinstance(owner, str)
        for nodeid, owner in raw.items()
    ):
        raise InputError("owners must map node IDs to owners")
    return {nodeid: owner for nodeid, owner in raw.items()}


def effective_outcome(raw: object) -> str:
    if not isinstance(raw, list) or not raw:
        raise InputError("attempts must be a non-empty array")
    seen: set[int] = set()
    selected_number = 0
    selected_outcome = ""
    for item in raw:
        if not isinstance(item, dict):
            raise InputError("attempt must be an object")
        number = item.get("attempt")
        outcome = item.get("outcome")
        if type(number) is not int or number <= 0:
            raise InputError("attempt must be a positive integer")
        if number in seen:
            raise InputError("attempt numbers must be unique")
        seen.add(number)
        if not isinstance(outcome, str) or outcome not in OUTCOMES:
            raise InputError("outcome must be passed, failed, or skipped")
        if number > selected_number:
            selected_number = number
            selected_outcome = outcome
    return selected_outcome


def read_run(path: Path) -> tuple[str, list[tuple[str, str]]]:
    raw: object = read_json(path)
    if not isinstance(raw, dict):
        raise InputError("run must be an object")
    run_id = raw.get("run_id")
    if run_id != path.stem:
        raise InputError("run ID must match its filename")
    if raw.get("schema_version") != 1:
        raise InputError("schema version must be 1")
    tests = raw.get("tests")
    if not isinstance(tests, list):
        raise InputError("tests must be an array")
    seen: set[str] = set()
    effective: list[tuple[str, str]] = []
    for item in tests:
        if not isinstance(item, dict):
            raise InputError("test must be an object")
        nodeid = item.get("nodeid")
        if not isinstance(nodeid, str):
            raise InputError("node ID must be a string")
        if nodeid in seen:
            raise InputError("node IDs must be unique within a run")
        seen.add(nodeid)
        effective.append((nodeid, effective_outcome(item.get("attempts"))))
    return run_id, effective


def add_outcome(counts: Counts, outcome: str) -> Counts:
    return Counts(
        passed=counts.passed + int(outcome == "passed"),
        failed=counts.failed + int(outcome == "failed"),
        skipped=counts.skipped + int(outcome == "skipped"),
    )


def percentage(failed: int, total: int) -> str:
    value = Decimal(failed * 100) / Decimal(total)
    return format(value.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP), "f")


def build_rows(root: Path) -> list[Row]:
    owners = read_owners(root / "owners.json")
    totals: dict[str, Counts] = {}
    run_ids: set[str] = set()
    for path in sorted((root / "artifacts").glob("run-*.json")):
        run_id, outcomes = read_run(path)
        if run_id in run_ids:
            raise InputError("run IDs must be unique")
        run_ids.add(run_id)
        for nodeid, outcome in outcomes:
            totals[nodeid] = add_outcome(totals.get(nodeid, Counts()), outcome)
    rows = [
        Row(
            nodeid=nodeid,
            owner=owners.get(nodeid, "UNOWNED"),
            passed=counts.passed,
            failed=counts.failed,
            skipped=counts.skipped,
            failure_percentage=percentage(
                counts.failed, counts.passed + counts.failed
            ),
        )
        for nodeid, counts in totals.items()
        if counts.passed and counts.failed
    ]
    return sorted(
        rows,
        key=lambda row: (
            -Fraction(row.failed, row.passed + row.failed),
            row.nodeid,
        ),
    )


def render(rows: list[Row]) -> str:
    lines = [
        "| nodeid | owner | passed | failed | skipped | failure_percentage |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ]
    lines.extend(
        f"| {row.nodeid} | {row.owner} | {row.passed} | {row.failed} | "
        f"{row.skipped} | {row.failure_percentage} |"
        for row in rows
    )
    return (
        "\n".join(lines)
        + "\n\nBEGIN_RESULT_JSON\n"
        + json.dumps([asdict(row) for row in rows], ensure_ascii=False)
        + "\nEND_RESULT_JSON\n"
    )


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("error: expected one fixture directory", file=sys.stderr)
        return 2
    try:
        result = render(build_rows(Path(argv[0])))
    except (InputError, OSError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(result, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
