from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from generate_fixture import generate_fixture, hash_tree
from oracle import write_report


class FixtureGenerationTests(unittest.TestCase):
    def test_checked_in_snapshots_equal_fresh_regeneration(self) -> None:
        expected = Path(__file__).resolve().parent / "expected"
        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            agent = base / "agent"
            evaluator = base / "evaluator"
            generate_fixture(agent, evaluator)
            write_report(agent, evaluator / "report.json")

            self.assertEqual(
                (evaluator / "fixture-manifest.json").read_bytes(),
                (expected / "fixture-manifest.json").read_bytes(),
            )
            self.assertEqual(
                (evaluator / "report.json").read_bytes(),
                (expected / "report.json").read_bytes(),
            )

    def test_generation_is_deterministic_and_large_enough(self) -> None:
        with TemporaryDirectory() as left, TemporaryDirectory() as right:
            one = generate_fixture(Path(left) / "agent", Path(left) / "eval")
            two = generate_fixture(Path(right) / "agent", Path(right) / "eval")
            self.assertEqual((one.schema_version, one.seed), (1, 20260809))
            self.assertEqual((one.run_count, one.test_id_count), (32, 80))
            self.assertGreaterEqual(one.attempt_count, 1800)
            self.assertEqual(one.files, two.files)

    def test_fixture_includes_all_required_edge_cases_and_canonical_json(self) -> None:
        with TemporaryDirectory() as temporary:
            base = Path(temporary)
            agent = base / "agent"
            evaluator = base / "evaluator"
            manifest = generate_fixture(agent, evaluator)

            manifest_path = evaluator / "fixture-manifest.json"
            self.assertEqual(
                manifest_path.read_bytes(),
                json.dumps(
                    manifest.to_json(), ensure_ascii=False, indent=2, sort_keys=True
                ).encode("utf-8")
                + b"\n",
            )
            self.assertEqual(manifest.files, tuple(hash_tree(agent).values()))
            self.assertTrue(all(not Path(digest.path).is_absolute() for digest in manifest.files))
            for path in sorted(agent.rglob("*.json")):
                raw = path.read_bytes()
                self.assertEqual(
                    raw,
                    json.dumps(
                        json.loads(raw.decode("utf-8")),
                        ensure_ascii=False,
                        indent=2,
                        sort_keys=True,
                    ).encode("utf-8")
                    + b"\n",
                )
            self.assertIn("雪".encode("utf-8"), (agent / "owners.json").read_bytes())

            owners = json.loads((agent / "owners.json").read_text(encoding="utf-8"))
            runs = [
                json.loads(path.read_text(encoding="utf-8"))
                for path in sorted((agent / "artifacts").glob("run-*.json"))
            ]
            occurrences: dict[str, list[dict[str, object]]] = {}
            has_unordered = False
            has_retry_change = False
            has_skip = False
            for run in runs:
                tests = run["tests"]
                self.assertEqual(len({test["nodeid"] for test in tests}), len(tests))
                for test in tests:
                    nodeid = test["nodeid"]
                    attempts = test["attempts"]
                    numbers = [attempt["attempt"] for attempt in attempts]
                    if numbers != sorted(numbers):
                        has_unordered = True
                    if len(attempts) > 1 and len(
                        {attempt["outcome"] for attempt in attempts}
                    ) > 1:
                        has_retry_change = True
                    effective = max(attempts, key=lambda attempt: attempt["attempt"])["outcome"]
                    has_skip = has_skip or effective == "skipped"
                    occurrences.setdefault(nodeid, []).append({"outcome": effective})

            self.assertTrue(has_unordered)
            self.assertTrue(has_retry_change)
            self.assertTrue(has_skip)
            self.assertTrue(any(len(values) < 32 for values in occurrences.values()))
            self.assertTrue(any(nodeid not in owners for nodeid in occurrences))
            self.assertIn('tests/stränge.py::test_雪', occurrences)
            self.assertIn('tests/[weird].py::test "quoted"', occurrences)
            self.assertIn('owner "quoted" / 雪', owners.values())

            ratios: dict[tuple[int, int], list[str]] = {}
            for nodeid, values in occurrences.items():
                outcomes = [value["outcome"] for value in values]
                passed, failed = outcomes.count("passed"), outcomes.count("failed")
                if passed and failed:
                    ratios.setdefault((failed, passed + failed), []).append(nodeid)
            self.assertTrue(any(len(nodeids) >= 2 for nodeids in ratios.values()))
            tie_nodeids = ("tests/a.py::test one", "tests/b.py::test_$quote")
            self.assertEqual(
                [nodeid for nodeid in sorted(ratios[(10, 19)]) if nodeid in tie_nodeids],
                list(tie_nodeids),
            )


if __name__ == "__main__":
    unittest.main()
