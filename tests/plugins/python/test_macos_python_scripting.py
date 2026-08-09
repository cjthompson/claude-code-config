#!/usr/bin/env python3
"""Regression coverage for the macOS Python scripting skill."""

from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SKILL = ROOT / "plugins/python-scripting/skills/macos-python-scripting/SKILL.md"


class MacosPythonScriptingTests(unittest.TestCase):
    def test_documents_generic_unittest_discovery(self) -> None:
        skill = SKILL.read_text()
        normalized_skill = " ".join(skill.replace("\\\n", " ").split())

        self.assertIn("dotted module names", normalized_skill)
        self.assertIn("not filesystem paths", normalized_skill)
        self.assertIn(
            "/usr/bin/python3 -m unittest discover "
            "-s <test-start-directory> "
            "-p '<test-file-pattern>' -v",
            normalized_skill,
        )


if __name__ == "__main__":
    unittest.main()
