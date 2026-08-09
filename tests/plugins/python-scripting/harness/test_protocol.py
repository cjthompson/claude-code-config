from __future__ import annotations

import json
import re
from pathlib import Path
import unittest

from oracle import ReportRecord
from protocol import ProtocolError, compare_results, extract_result_json, lint_prompt


PROMPT_PATH = (
    Path(__file__).parents[1] / "prompts" / "incidental-helper.txt"
)
FORBIDDEN = re.compile(r"\b(?:python|scripts?|plugins?|helpers?|tools?)\b", re.I)


class PromptContractTests(unittest.TestCase):
    def test_prompt_is_indirect_and_complete(self) -> None:
        prompt = PROMPT_PATH.read_text(encoding="utf-8")
        self.assertIsNone(FORBIDDEN.search(prompt))
        for phrase in (
            "greatest attempt number",
            "UNOWNED",
            "excluding skips",
            "half-up rounding",
            "exact unrounded failure ratio",
            "BEGIN_RESULT_JSON",
            "END_RESULT_JSON",
            "one-decimal string",
            "Do not modify the input files",
            "exactly one Markdown table",
        ):
            self.assertIn(phrase, prompt)


class ResultProtocolTests(unittest.TestCase):
    records = (
        ReportRecord("tests/a.py::test one", "alpha", 1, 1, 1, "50.0"),
        ReportRecord("tests/b.py::test two", "UNOWNED", 2, 1, 0, "33.3"),
    )

    def response(self, records: tuple[ReportRecord, ...] | None = None) -> str:
        selected = self.records if records is None else records
        rows = [
            "| nodeid | owner | passed | failed | skipped | failure_percentage |",
            "| --- | --- | ---: | ---: | ---: | ---: |",
        ]
        rows.extend(
            f"| {record.nodeid} | {record.owner} | {record.passed} | "
            f"{record.failed} | {record.skipped} | {record.failure_percentage} |"
            for record in selected
        )
        return (
            "\n".join(rows)
            + "\n\nBEGIN_RESULT_JSON\n"
            + json.dumps([record.__dict__ for record in selected])
            + "\nEND_RESULT_JSON\n"
        )

    def test_extracts_valid_marked_array_in_order(self) -> None:
        self.assertEqual(extract_result_json(self.response()), self.records)

    def test_rejects_missing_markers(self) -> None:
        with self.assertRaisesRegex(ProtocolError, "markers"):
            extract_result_json("[]")

    def test_rejects_reversed_markers(self) -> None:
        response = "END_RESULT_JSON\nBEGIN_RESULT_JSON\n[]\n"
        with self.assertRaisesRegex(ProtocolError, "wrong order"):
            extract_result_json(response)

    def test_rejects_duplicate_markers(self) -> None:
        response = self.response() + "BEGIN_RESULT_JSON\n[]\nEND_RESULT_JSON\n"
        with self.assertRaisesRegex(ProtocolError, "exactly one"):
            extract_result_json(response)

    def test_rejects_invalid_json(self) -> None:
        response = "BEGIN_RESULT_JSON\nnot json\nEND_RESULT_JSON\n"
        with self.assertRaisesRegex(ProtocolError, "JSON"):
            extract_result_json(response)

    def test_rejects_extra_keys(self) -> None:
        response = self.response().replace(
            '"failure_percentage": "50.0"',
            '"failure_percentage": "50.0", "extra": 1',
        )
        with self.assertRaisesRegex(ProtocolError, "keys"):
            extract_result_json(response)

    def test_rejects_duplicate_node_ids(self) -> None:
        duplicate = (self.records[0], self.records[0])
        with self.assertRaisesRegex(ProtocolError, "duplicate nodeid"):
            extract_result_json(self.response(duplicate))

    def test_rejects_boolean_counts(self) -> None:
        response = self.response().replace('"passed": 1', '"passed": true', 1)
        with self.assertRaisesRegex(ProtocolError, "passed"):
            extract_result_json(response)

    def test_rejects_negative_counts(self) -> None:
        response = self.response().replace('"failed": 1', '"failed": -1', 1)
        with self.assertRaisesRegex(ProtocolError, "nonnegative"):
            extract_result_json(response)

    def test_rejects_numeric_percentages(self) -> None:
        response = self.response().replace(
            '"failure_percentage": "50.0"', '"failure_percentage": 50.0', 1
        )
        with self.assertRaisesRegex(ProtocolError, "failure_percentage"):
            extract_result_json(response)

    def test_rejects_malformed_one_decimal_strings(self) -> None:
        for value in ("50", "50.00", "-1.0", "x.0"):
            with self.subTest(value=value):
                response = self.response().replace(
                    '"failure_percentage": "50.0"',
                    f'"failure_percentage": "{value}"',
                    1,
                )
                with self.assertRaisesRegex(ProtocolError, "one-decimal"):
                    extract_result_json(response)

    def test_rejects_markdown_json_disagreement(self) -> None:
        response = self.response().replace(
            "| alpha | 1 | 1 | 1 | 50.0 |",
            "| wrong-owner | 1 | 1 | 1 | 50.0 |",
        )
        with self.assertRaisesRegex(ProtocolError, "Markdown"):
            extract_result_json(response)

    def test_rejects_missing_markdown_table(self) -> None:
        response = self.response().split("\n\nBEGIN_RESULT_JSON", 1)[1]
        with self.assertRaisesRegex(ProtocolError, "exactly one Markdown table"):
            extract_result_json("BEGIN_RESULT_JSON" + response)

    def test_rejects_duplicate_markdown_tables(self) -> None:
        table, marked = self.response().split("\n\n", 1)
        with self.assertRaisesRegex(ProtocolError, "exactly one Markdown table"):
            extract_result_json(f"{table}\n\n{table}\n\n{marked}")

    def test_rejects_malformed_markdown_table(self) -> None:
        response = self.response().replace(
            "| --- | --- | ---: | ---: | ---: | ---: |",
            "| --- | not-a-separator | ---: | ---: | ---: | ---: |",
        )
        with self.assertRaisesRegex(ProtocolError, "invalid separator"):
            extract_result_json(response)

    def test_compare_reports_stable_differences_and_detects_wrong_order(self) -> None:
        differences = compare_results(self.records[::-1], self.records)
        self.assertEqual(
            differences,
            (
                "record 0 field nodeid differs: actual "
                "'tests/b.py::test two', expected 'tests/a.py::test one'",
                "record 0 field owner differs: actual 'UNOWNED', "
                "expected 'alpha'",
                "record 0 field passed differs: actual 2, expected 1",
                "record 0 field skipped differs: actual 0, expected 1",
                "record 0 field failure_percentage differs: actual '33.3', "
                "expected '50.0'",
                "record 1 field nodeid differs: actual 'tests/a.py::test one', "
                "expected 'tests/b.py::test two'",
                "record 1 field owner differs: actual 'alpha', "
                "expected 'UNOWNED'",
                "record 1 field passed differs: actual 1, expected 2",
                "record 1 field skipped differs: actual 1, expected 0",
                "record 1 field failure_percentage differs: actual '50.0', "
                "expected '33.3'",
            ),
        )
        self.assertEqual(compare_results(self.records, self.records), ())

    def test_lint_prompt_reports_forbidden_and_missing_terms(self) -> None:
        findings = lint_prompt("Use a Python helper.")
        self.assertEqual(
            findings,
            (
                "forbidden term: Python",
                "forbidden term: helper",
                "missing phrase: greatest attempt number",
                "missing phrase: UNOWNED",
                "missing phrase: excluding skips",
                "missing phrase: half-up rounding",
                "missing phrase: exact unrounded failure ratio",
                "missing phrase: BEGIN_RESULT_JSON",
                "missing phrase: END_RESULT_JSON",
                "missing phrase: one-decimal string",
                "missing phrase: Do not modify the input files",
            ),
        )


if __name__ == "__main__":
    unittest.main()
