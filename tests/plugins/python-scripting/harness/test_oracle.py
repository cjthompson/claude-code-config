from __future__ import annotations

import json
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
import unittest

from oracle import InputError, ReportRecord, build_report, write_report


SMALL_FIXTURE = Path(__file__).parent / "fixtures" / "oracle-small"


class OracleTests(unittest.TestCase):
    def copied_fixture(self) -> tuple[TemporaryDirectory[str], Path]:
        temporary = TemporaryDirectory()
        destination = Path(temporary.name) / "fixture"
        shutil.copytree(SMALL_FIXTURE, destination)
        return temporary, destination

    def write_json(self, path: Path, payload: object) -> None:
        path.write_text(json.dumps(payload), encoding="utf-8")

    def test_small_fixture_matches_hand_calculation(self) -> None:
        self.assertEqual(
            build_report(SMALL_FIXTURE),
            (
                ReportRecord("tests/a.py::test one", "alpha", 1, 1, 1, "50.0"),
                ReportRecord("tests/b.py::test_$quote", "UNOWNED", 1, 1, 0, "50.0"),
            ),
        )

    def test_write_report_is_canonical_json(self) -> None:
        with TemporaryDirectory() as temporary:
            destination = Path(temporary) / "report.json"
            write_report(SMALL_FIXTURE, destination)
            self.assertEqual(
                destination.read_bytes(),
                b'[\n  {\n    "failed": 1,\n    "failure_percentage": "50.0",\n'
                b'    "nodeid": "tests/a.py::test one",\n    "owner": "alpha",\n'
                b'    "passed": 1,\n    "skipped": 1\n  },\n  {\n'
                b'    "failed": 1,\n    "failure_percentage": "50.0",\n'
                b'    "nodeid": "tests/b.py::test_$quote",\n    "owner": "UNOWNED",\n'
                b'    "passed": 1,\n    "skipped": 0\n  }\n]\n',
            )

    def test_rejects_boolean_attempt_number(self) -> None:
        temporary, fixture = self.copied_fixture()
        with temporary:
            self.replace_first_attempt(fixture, True)
            with self.assertRaisesRegex(InputError, "positive integer"):
                build_report(fixture)

    def test_rejects_duplicate_attempt_numbers(self) -> None:
        temporary, fixture = self.copied_fixture()
        with temporary:
            self.replace_first_attempt(fixture, 1)
            with self.assertRaisesRegex(InputError, "duplicate attempt"):
                build_report(fixture)

    def test_rejects_unknown_outcome(self) -> None:
        temporary, fixture = self.copied_fixture()
        with temporary:
            path = fixture / "artifacts" / "run-001.json"
            payload = json.loads(path.read_text())
            payload["tests"][0]["attempts"][0]["outcome"] = "broken"
            self.write_json(path, payload)
            with self.assertRaisesRegex(InputError, "outcome"):
                build_report(fixture)

    def test_rejects_invalid_schema_and_run_id_mismatch(self) -> None:
        temporary, fixture = self.copied_fixture()
        with temporary:
            path = fixture / "artifacts" / "run-001.json"
            payload = json.loads(path.read_text())
            payload["schema_version"] = 2
            self.write_json(path, payload)
            with self.assertRaisesRegex(InputError, "schema_version"):
                build_report(fixture)
            payload["schema_version"] = 1
            payload["run_id"] = "run-other"
            self.write_json(path, payload)
            with self.assertRaisesRegex(InputError, "run_id"):
                build_report(fixture)

    def test_rejects_duplicate_nodeids_and_malformed_owners(self) -> None:
        temporary, fixture = self.copied_fixture()
        with temporary:
            path = fixture / "artifacts" / "run-001.json"
            payload = json.loads(path.read_text())
            payload["tests"].append(payload["tests"][0])
            self.write_json(path, payload)
            with self.assertRaisesRegex(InputError, "duplicate nodeid"):
                build_report(fixture)
            payload["tests"].pop()
            self.write_json(path, payload)
            self.write_json(fixture / "owners.json", ["not", "an", "object"])
            with self.assertRaisesRegex(InputError, "owners"):
                build_report(fixture)

    def test_rejects_non_container_json_roots(self) -> None:
        temporary, fixture = self.copied_fixture()
        with temporary:
            self.write_json(fixture / "owners.json", "not an object")
            with self.assertRaisesRegex(InputError, "owners"):
                build_report(fixture)
            self.write_json(fixture / "owners.json", {"tests/a.py::test one": "alpha"})
            self.write_json(fixture / "artifacts" / "run-001.json", [])
            with self.assertRaisesRegex(InputError, "artifact"):
                build_report(fixture)

    def replace_first_attempt(self, fixture: Path, value: object) -> None:
        path = fixture / "artifacts" / "run-001.json"
        payload = json.loads(path.read_text())
        payload["tests"][0]["attempts"][0]["attempt"] = value
        self.write_json(path, payload)


if __name__ == "__main__":
    unittest.main()
