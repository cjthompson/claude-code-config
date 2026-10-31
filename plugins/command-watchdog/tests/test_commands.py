import os, unittest

COMMANDS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "commands")
EXPECT = {
    "stats.md": ["stats"],
    "suggest-timeouts.md": ["suggest-timeouts", "--apply"],
    "reset-stats.md": ["reset-stats", "--yes"],
    "delete-stats.md": ["delete-stats", "--all", "--yes"],
    "enable-stats.md": ["enable-stats"],
}


class CommandFileTests(unittest.TestCase):
    def test_files_exist_with_frontmatter_and_subcommand(self):
        for name, words in EXPECT.items():
            with self.subTest(name=name):
                text = open(os.path.join(COMMANDS, name), encoding="utf-8").read()
                self.assertTrue(text.startswith("---\ndescription: "))
                for word in words:
                    self.assertIn(word, text)
                self.assertIn("CLAUDE_PLUGIN_ROOT", text)

    def test_destructive_commands_require_confirmation(self):
        for name in ("reset-stats.md", "delete-stats.md", "suggest-timeouts.md"):
            with self.subTest(name=name):
                text = open(os.path.join(COMMANDS, name), encoding="utf-8").read()
                self.assertIn("AskUserQuestion", text)

    def test_suggest_apply_step_asks_with_ask_user_question(self):
        with open(os.path.join(COMMANDS, "suggest-timeouts.md"), encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("Ask with AskUserQuestion whether to apply the previewed change; run `--apply` only on a yes.",
                      text)


if __name__ == "__main__":
    unittest.main()
