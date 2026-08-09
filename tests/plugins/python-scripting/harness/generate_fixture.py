"""Create the deterministic input fixture for the incidental-helper harness."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
from typing import TypedDict


SCHEMA_VERSION = 1
SEED = 20260809
RUN_COUNT = 32
TEST_COUNT = 80
MIN_ATTEMPT_COUNT = 1800

_OUTCOMES = ("passed", "failed", "skipped")


class _Attempt(TypedDict):
    attempt: int
    outcome: str


class _TestEntry(TypedDict):
    attempts: list[_Attempt]
    nodeid: str


@dataclass(frozen=True)
class FileDigest:
    path: str
    sha256: str
    byte_count: int


@dataclass(frozen=True)
class FixtureManifest:
    schema_version: int
    seed: int
    run_count: int
    test_id_count: int
    attempt_count: int
    files: tuple[FileDigest, ...]

    def to_json(self) -> dict[str, object]:
        return {
            "attempt_count": self.attempt_count,
            "files": [asdict(digest) for digest in self.files],
            "run_count": self.run_count,
            "schema_version": self.schema_version,
            "seed": self.seed,
            "test_id_count": self.test_id_count,
        }


def hash_tree(root: Path) -> dict[str, FileDigest]:
    """Return stable, relative digests for every file below *root*."""
    return {
        relative: FileDigest(
            path=relative,
            sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            byte_count=path.stat().st_size,
        )
        for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file())
        for relative in (path.relative_to(root).as_posix(),)
    }


def generate_fixture(agent_workspace: Path, evaluator_workspace: Path) -> FixtureManifest:
    """Populate fresh workspaces with deterministic, schema-valid JSON input."""
    agent_workspace.mkdir(parents=True, exist_ok=True)
    artifacts = agent_workspace / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    evaluator_workspace.mkdir(parents=True, exist_ok=True)

    nodeids = _nodeids()
    owners = _owners(nodeids)
    _assert_static_invariants(nodeids, owners)
    _write_json(agent_workspace / "owners.json", owners)

    attempt_count = 0
    saw_absence = False
    saw_unordered = False
    saw_changed_retry = False
    saw_skip = False
    for run_number in range(1, RUN_COUNT + 1):
        tests: list[_TestEntry] = []
        for test_index, nodeid in enumerate(nodeids):
            if _is_absent(test_index, run_number):
                saw_absence = True
                continue
            attempts = _attempts(test_index, run_number)
            attempt_count += len(attempts)
            numbers = [attempt["attempt"] for attempt in attempts]
            saw_unordered = saw_unordered or numbers != sorted(numbers)
            saw_changed_retry = saw_changed_retry or (
                len(attempts) > 1
                and len({attempt["outcome"] for attempt in attempts}) > 1
            )
            effective = max(attempts, key=lambda attempt: attempt["attempt"])["outcome"]
            saw_skip = saw_skip or effective == "skipped"
            tests.append({"attempts": attempts, "nodeid": nodeid})

        run_id = f"run-{run_number:03d}"
        _assert_run_invariants(run_id, tests)
        _write_json(
            artifacts / f"{run_id}.json",
            {"run_id": run_id, "schema_version": SCHEMA_VERSION, "tests": tests},
        )

    assert attempt_count >= MIN_ATTEMPT_COUNT
    assert saw_absence
    assert saw_unordered
    assert saw_changed_retry
    assert saw_skip
    assert any(nodeid not in owners for nodeid in nodeids)

    files = tuple(hash_tree(agent_workspace).values())
    manifest = FixtureManifest(
        schema_version=SCHEMA_VERSION,
        seed=SEED,
        run_count=RUN_COUNT,
        test_id_count=TEST_COUNT,
        attempt_count=attempt_count,
        files=files,
    )
    _write_json(evaluator_workspace / "fixture-manifest.json", manifest.to_json())
    return manifest


def _nodeids() -> tuple[str, ...]:
    special = (
        "tests/a.py::test one",
        "tests/b.py::test_$quote",
        "tests/stränge.py::test_雪",
        'tests/[weird].py::test "quoted"',
    )
    ordinary = tuple(
        f"tests/case_{index:02d}.py::test_case_{index:02d}"
        for index in range(len(special), TEST_COUNT)
    )
    return special + ordinary


def _owners(nodeids: tuple[str, ...]) -> dict[str, str]:
    owners: dict[str, str] = {}
    for index, nodeid in enumerate(nodeids):
        if index % 11 == 0:
            continue
        owners[nodeid] = "owner \"quoted\" / 雪" if index == 2 else f"team-{index % 7}"
    return owners


def _is_absent(test_index: int, run_number: int) -> bool:
    if test_index in (0, 1):
        return run_number % 7 == 0
    return (test_index * 5 + run_number * 7) % 17 == 0


def _attempts(test_index: int, run_number: int) -> list[_Attempt]:
    outcome_index = (run_number * 5) % 3 if test_index in (0, 1) else (
        test_index * 11 + run_number * 7
    ) % 3
    effective = _OUTCOMES[outcome_index]
    attempts: list[_Attempt] = [{"attempt": 1, "outcome": effective}]
    if (test_index * 13 + run_number * 3) % 4 == 0:
        previous = _OUTCOMES[(outcome_index + 1) % len(_OUTCOMES)]
        attempts = [
            {"attempt": 1, "outcome": previous},
            {"attempt": 2, "outcome": effective},
        ]
        if (test_index + run_number) % 2 == 0:
            attempts.reverse()
    return attempts


def _assert_static_invariants(nodeids: tuple[str, ...], owners: dict[str, str]) -> None:
    assert len(nodeids) == TEST_COUNT
    assert len(set(nodeids)) == TEST_COUNT
    assert set(owners).issubset(nodeids)
    assert all(isinstance(owner, str) for owner in owners.values())
    assert 'tests/stränge.py::test_雪' in nodeids
    assert 'tests/[weird].py::test "quoted"' in nodeids


def _assert_run_invariants(run_id: str, tests: list[_TestEntry]) -> None:
    assert run_id.startswith("run-")
    nodeids = [test["nodeid"] for test in tests]
    assert len(nodeids) == len(set(nodeids))
    for test in tests:
        attempts = test["attempts"]
        assert attempts
        numbers = [attempt["attempt"] for attempt in attempts]
        assert len(numbers) == len(set(numbers))
        assert all(type(number) is int and number > 0 for number in numbers)
        assert all(attempt["outcome"] in _OUTCOMES for attempt in attempts)


def _write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
