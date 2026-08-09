"""Prompt linting and strict result handling for the incidental helper."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import fields
import json
import re
from typing import Final

from oracle import ReportRecord


ResultRecord = ReportRecord

FORBIDDEN: Final[re.Pattern[str]] = re.compile(
    r"\b(?:python|scripts?|plugins?|helpers?|tools?)\b", re.IGNORECASE
)
_PERCENTAGE: Final[re.Pattern[str]] = re.compile(r"^[0-9]+\.[0-9]$")
_REQUIRED_PHRASES: Final[tuple[str, ...]] = (
    "greatest attempt number",
    "UNOWNED",
    "excluding skips",
    "half-up rounding",
    "exact unrounded failure ratio",
    "BEGIN_RESULT_JSON",
    "END_RESULT_JSON",
    "one-decimal string",
    "Do not modify the input files",
)
_MARKER_BEGIN: Final[str] = "BEGIN_RESULT_JSON"
_MARKER_END: Final[str] = "END_RESULT_JSON"
_REQUIRED_KEYS: Final[frozenset[str]] = frozenset(
    field.name for field in fields(ReportRecord)
)
_TABLE_HEADERS: Final[tuple[str, ...]] = (
    "nodeid",
    "owner",
    "passed",
    "failed",
    "skipped",
    "failure_percentage",
)


class ProtocolError(ValueError):
    """The response does not satisfy the marked result protocol."""


def lint_prompt(prompt: str) -> tuple[str, ...]:
    """Return deterministic findings for forbidden or missing prompt text."""
    findings = [
        f"forbidden term: {match.group(0)}" for match in FORBIDDEN.finditer(prompt)
    ]
    findings.extend(
        f"missing phrase: {phrase}"
        for phrase in _REQUIRED_PHRASES
        if phrase not in prompt
    )
    return tuple(findings)


def extract_result_json(response: str) -> tuple[ResultRecord, ...]:
    """Extract, validate, and preserve the marked records from a response."""
    if response.count(_MARKER_BEGIN) != 1 or response.count(_MARKER_END) != 1:
        raise ProtocolError("response must contain exactly one pair of result markers")
    begin = response.index(_MARKER_BEGIN) + len(_MARKER_BEGIN)
    end = response.index(_MARKER_END)
    if begin > end:
        raise ProtocolError("result markers are in the wrong order")

    try:
        payload: object = json.loads(
            response[begin:end], object_pairs_hook=_object_from_pairs
        )
    except ProtocolError:
        raise
    except json.JSONDecodeError as error:
        raise ProtocolError(f"invalid result JSON: {error.msg}") from error

    if not isinstance(payload, list):
        raise ProtocolError("result JSON must be an array")

    records: list[ResultRecord] = []
    seen_nodeids: set[str] = set()
    for index, value in enumerate(payload):
        records.append(_parse_record(value, index, seen_nodeids))

    parsed = tuple(records)
    _check_markdown_consistency(response[: response.index(_MARKER_BEGIN)], parsed)
    return parsed


def compare_results(
    actual: Sequence[ResultRecord], expected: Sequence[ResultRecord]
) -> tuple[str, ...]:
    """Return stable, field-level differences without changing either input."""
    differences: list[str] = []
    if len(actual) != len(expected):
        differences.append(
            f"record count differs: actual {len(actual)}, expected {len(expected)}"
        )

    field_names = tuple(field.name for field in fields(ReportRecord))
    for index, (actual_record, expected_record) in enumerate(
        zip(actual, expected)
    ):
        for name in field_names:
            actual_value = getattr(actual_record, name, _MISSING)
            expected_value = getattr(expected_record, name, _MISSING)
            if actual_value != expected_value:
                differences.append(
                    f"record {index} field {name} differs: "
                    f"actual {actual_value!r}, expected {expected_value!r}"
                )
    return tuple(differences)


_MISSING = object()


def _object_from_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _parse_record(
    value: object, index: int, seen_nodeids: set[str]
) -> ResultRecord:
    if not isinstance(value, dict):
        raise ProtocolError(f"record {index} must be an object")
    keys = frozenset(value)
    if keys != _REQUIRED_KEYS:
        raise ProtocolError(
            f"record {index} must contain exactly these keys: "
            f"{sorted(_REQUIRED_KEYS)!r}"
        )

    nodeid = value["nodeid"]
    owner = value["owner"]
    if not isinstance(nodeid, str):
        raise ProtocolError(f"record {index} nodeid must be a string")
    if nodeid in seen_nodeids:
        raise ProtocolError(f"duplicate nodeid: {nodeid}")
    seen_nodeids.add(nodeid)
    if not isinstance(owner, str):
        raise ProtocolError(f"record {index} owner must be a string")

    counts: dict[str, int] = {}
    for name in ("passed", "failed", "skipped"):
        count = value[name]
        if type(count) is not int or count < 0:
            raise ProtocolError(
                f"record {index} {name} must be a nonnegative integer"
            )
        counts[name] = count

    percentage = value["failure_percentage"]
    if not isinstance(percentage, str) or _PERCENTAGE.fullmatch(percentage) is None:
        raise ProtocolError(
            f"record {index} failure_percentage must be a one-decimal string"
        )
    return ReportRecord(
        nodeid=nodeid,
        owner=owner,
        failure_percentage=percentage,
        **counts,
    )


def _split_table_row(line: str) -> tuple[str, ...] | None:
    stripped = line.strip()
    if not stripped.startswith("|") or not stripped.endswith("|"):
        return None
    return tuple(cell.strip() for cell in stripped[1:-1].split("|"))


def _check_markdown_consistency(
    prefix: str, records: tuple[ResultRecord, ...]
) -> None:
    tables: list[list[str]] = []
    current: list[str] = []
    for line in prefix.splitlines():
        if line.strip().startswith("|"):
            current.append(line)
        elif current:
            tables.append(current)
            current = []
    if current:
        tables.append(current)
    if len(tables) != 1:
        raise ProtocolError("response must contain exactly one Markdown table")

    parsed_rows = tuple(_split_table_row(line) for line in tables[0])
    if not parsed_rows or parsed_rows[0] != _TABLE_HEADERS:
        raise ProtocolError("Markdown table has an invalid header row")
    if len(parsed_rows) < 2:
        raise ProtocolError("Markdown table is missing its separator row")
    separator = parsed_rows[1]
    if separator is None or len(separator) != len(_TABLE_HEADERS) or not all(
        re.fullmatch(r":?-+:?", cell) for cell in separator
    ):
        raise ProtocolError("Markdown table has an invalid separator row")

    rows: list[tuple[str, ...]] = []
    for row in parsed_rows[2:]:
        if row is None:
            break
        if len(row) != len(_TABLE_HEADERS):
            raise ProtocolError("Markdown table has an invalid record row")
        rows.append(row)

    expected_rows = tuple(
        (
            record.nodeid,
            record.owner,
            str(record.passed),
            str(record.failed),
            str(record.skipped),
            record.failure_percentage,
        )
        for record in records
    )
    if tuple(rows) != expected_rows:
        raise ProtocolError("Markdown table does not match marked JSON records")
