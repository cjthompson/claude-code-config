import os, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
import watchdog_config
from watchdog_config import load_rules, parse_value, resolve


def write(directory, name, text):
    path = os.path.join(directory, name)
    with open(path, "w") as handle:
        handle.write(text)
    return path


class OverrideTableTests(unittest.TestCase):
    def test_one_table_names_every_override_variable(self):
        self.assertEqual(watchdog_config.ENV_NAMES, {
            "idle": "WATCHDOG_IDLE", "max_runtime": "WATCHDOG_MAX_RUNTIME",
            "poll_cap": "WATCHDOG_POLL_CAP", "poll": "WATCHDOG_POLL"})

    def test_liftable_keys_are_declared_next_to_the_names(self):
        self.assertEqual(watchdog_config.LIFTABLE_KEYS, ("idle", "max_runtime", "poll_cap"))


class DefaultSectionTests(unittest.TestCase):
    def test_default_section_is_not_copied_into_other_sections(self):
        with tempfile.TemporaryDirectory() as directory:
            path = write(directory, "rules.ini",
                         "[DEFAULT]\nidle = 300\n\n[global]\nidle = 120\n\n"
                         "[command:npm]\n\n[rule:r]\nregex = foo\n")
            rules, _ = load_rules([path])
        self.assertEqual(rules.global_values, {"idle": 120})
        self.assertEqual(rules.commands.get("npm", {}), {})
        self.assertEqual(rules.rules[0][2], {})


class ParseValueTests(unittest.TestCase):
    def test_disable_markers(self):
        self.assertIsNone(parse_value("idle", "-1"))
        self.assertIsNone(parse_value("idle", "off"))
        self.assertIsNone(parse_value("max_runtime", "0"))
        self.assertIsNone(parse_value("max_runtime", "off"))

    def test_invalid_values(self):
        for key, raw in [("idle", "0"), ("poll_cap", "0"), ("poll", "off"), ("poll", "-1"),
                         ("nice", "maybe"), ("acceptable_kill_percent", "0"), ("idle", "x")]:
            with self.subTest(key=key, raw=raw):
                with self.assertRaises(ValueError):
                    parse_value(key, raw)

    def test_nice_values(self):
        self.assertTrue(parse_value("nice", "on"))
        self.assertFalse(parse_value("nice", "off"))


class LoadAndResolveTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def test_builtin_defaults(self):
        rules, warnings = load_rules([])
        result = resolve(rules, "npm test", "npm test", {})
        self.assertEqual((result.limits.idle, result.limits.max_runtime, result.limits.poll,
                          result.limits.poll_cap, result.limits.nice), (90, None, 5, 1800, True))
        self.assertEqual(warnings, [])

    def test_rtk_builtin_cap_survives_global_off(self):
        path = write(self.dir.name, "a.ini", "[global]\nmax_runtime: off\n")
        rules, _ = load_rules([path])
        self.assertEqual(resolve(rules, "rtk hook", "rtk hook claude", {}).limits.max_runtime, 15)

    def test_longest_prefix_wins_and_is_word_bounded(self):
        path = write(self.dir.name, "a.ini",
                     "[command:git]\nidle: 120\n[command:git push]\nidle: 600\n")
        rules, _ = load_rules([path])
        self.assertEqual(resolve(rules, "git push origin", "git push origin", {}).limits.idle, 600)
        self.assertEqual(resolve(rules, "git status", "git status", {}).limits.idle, 120)
        self.assertEqual(resolve(rules, "gitk", "gitk", {}).limits.idle, 90)

    def test_rule_regex_beats_command(self):
        path = write(self.dir.name, "a.ini",
                     "[rule:shell-scripts]\nregex: \\.sh\\b\nidle: 300\n[command:bash]\nidle: 120\n")
        rules, _ = load_rules([path])
        result = resolve(rules, "bash scripts/run.sh", "bash scripts/run.sh", {})
        self.assertEqual(result.limits.idle, 300)
        self.assertEqual(result.rule_key, "rule:shell-scripts")

    def test_invalid_regex_skips_section_with_warning(self):
        path = write(self.dir.name, "a.ini", "[rule:bad]\nregex: (\nidle: 300\n")
        rules, warnings = load_rules([path])
        self.assertTrue(any("bad" in w for w in warnings))
        self.assertEqual(resolve(rules, "x", "x", {}).limits.idle, 90)

    def test_rule_without_regex_is_skipped_with_warning(self):
        for text in ("[rule:typo]\nregexp: npm\nidle: 5\n", "[rule:typo]\nregex:\nidle: 5\n",
                     "[rule:typo]\nregex:   \nidle: 5\n"):
            with self.subTest(text=text):
                path = write(self.dir.name, "r.ini", text)
                rules, warnings = load_rules([path])
                self.assertEqual(rules.rules, [])
                self.assertTrue(any("rule:typo: missing or empty regex" in w for w in warnings), warnings)
                result = resolve(rules, "ls", "ls -la", {})
                self.assertEqual(result.rule_key, "global")
                self.assertEqual(result.limits.idle, 90)

    def test_later_rule_section_without_regex_keeps_earlier_regex(self):
        plugin = write(self.dir.name, "plugin.ini", "[rule:scripts]\nregex: \\.sh\\b\nidle: 300\n")
        data = write(self.dir.name, "data.ini", "[rule:scripts]\nidle: 600\n")
        rules, warnings = load_rules([plugin, data])
        self.assertEqual(warnings, [])
        self.assertEqual(resolve(rules, "x", "./build.sh", {}).limits.idle, 600)
        unrelated = resolve(rules, "ls", "ls -la", {})
        self.assertEqual((unrelated.rule_key, unrelated.limits.idle), ("global", 90))

    def test_data_directory_overrides_per_key_and_keeps_plugin_values(self):
        plugin = write(self.dir.name, "plugin.ini", "[command:make]\nidle: 300\nmax_runtime: 900\n")
        data = write(self.dir.name, "data.ini", "[command:make]\nidle: 120\n")
        rules, _ = load_rules([plugin, data])
        result = resolve(rules, "make", "make", {})
        self.assertEqual((result.limits.idle, result.limits.max_runtime), (120, 900))

    def test_malformed_file_is_a_warning_not_an_error(self):
        path = write(self.dir.name, "a.ini", "[global\nidle 90\n")
        rules, warnings = load_rules([path])
        self.assertTrue(warnings)
        self.assertEqual(resolve(rules, "x", "x", {}).limits.idle, 90)

    def test_garbage_line_keeps_valid_keys_before_and_after(self):
        path = write(self.dir.name, "a.ini",
                     "[global]\nidle: 10\nbad line without sep\npoll: 7\n")
        rules, warnings = load_rules([path])
        self.assertTrue(warnings)
        result = resolve(rules, "x", "x", {})
        self.assertEqual((result.limits.idle, result.limits.poll), (10, 7))

    def test_literal_percent_in_regex(self):
        path = write(self.dir.name, "a.ini", "[rule:pct]\nregex: 100%\nidle: 30\n")
        rules, warnings = load_rules([path])
        self.assertEqual(warnings, [])
        self.assertEqual(resolve(rules, "x", "run 100%", {}).limits.idle, 30)

    def test_environment_overrides_ini_and_reports_variable(self):
        path = write(self.dir.name, "a.ini", "[command:make]\nidle: 300\n")
        rules, _ = load_rules([path])
        result = resolve(rules, "make", "make", {"idle": "600"})
        self.assertEqual(result.limits.idle, 600)
        self.assertTrue(result.overridden)
        self.assertEqual(result.override_vars, ("WATCHDOG_IDLE",))

    def test_negative_one_override_disables_max_runtime(self):
        rules, _ = load_rules([])
        self.assertIsNone(resolve(rules, "make", "make", {"max_runtime": "-1"}).limits.max_runtime)

    def test_invalid_environment_value_is_ignored_with_warning(self):
        rules, _ = load_rules([])
        result = resolve(rules, "make", "make", {"idle": "0"})
        self.assertEqual(result.limits.idle, 90)
        self.assertTrue(result.warnings)

    def test_ini_values_exclude_environment(self):
        rules, _ = load_rules([])
        result = resolve(rules, "make", "make", {"idle": "600"})
        self.assertEqual(result.ini_values["idle"], 90)


class NewParserTests(unittest.TestCase):
    def test_factory_reads_default_section_as_an_ordinary_section(self):
        parser = watchdog_config.new_parser()
        parser.read_string("[DEFAULT]\nx = 1\n[a]\ny = 2\n")
        self.assertNotIn("x", parser["a"])
        self.assertEqual(parser["DEFAULT"]["x"], "1")

    def test_factory_keeps_percent_literal_and_tolerates_duplicate_keys(self):
        parser = watchdog_config.new_parser()
        parser.read_string("[a]\nk = 100%\nk = 2\n")
        self.assertEqual(parser["a"]["k"], "2")
        parser.read_string("[b]\nk = 100%\n")
        self.assertEqual(parser["b"]["k"], "100%")


class RtkDecisionRuleTests(unittest.TestCase):
    """The rtk rewrite lookup is the hook's own call: its built-in cap must not depend on user rules."""

    def test_decision_call_keeps_its_cap_against_a_matching_rule(self):
        with tempfile.TemporaryDirectory() as directory:
            rules, _ = load_rules([write(directory, "a.ini", "[rule:everything]\nregex: .\nmax_runtime: off\n")])
            result = resolve(rules, "rtk hook", "rtk hook claude < /tmp/f", {}, match_rules=False)
        self.assertEqual(result.limits.max_runtime, 15)
        self.assertEqual(result.rule_key, "command:rtk")

    def test_ordinary_command_still_takes_its_matching_rule_first(self):
        with tempfile.TemporaryDirectory() as directory:
            rules, _ = load_rules([write(directory, "a.ini", "[rule:everything]\nregex: .\nmax_runtime: off\n")])
            result = resolve(rules, "rtk hook", "rtk hook claude", {})
        self.assertIsNone(result.limits.max_runtime)
        self.assertEqual(result.rule_key, "rule:everything")


class RegexMatchesOriginalTests(unittest.TestCase):
    """The hook matches [rule:] regexes against --original, the text before rtk rewrote it."""

    def setUp(self):
        import importlib.util
        from unittest.mock import patch
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        write(self.dir.name, "watchdog-patterns.ini", "[rule:original-only]\nregex: wd-original-marker\nidle: 7\n")
        env = {k: v for k, v in os.environ.items() if not k.startswith("WATCHDOG_")}
        env["COMMAND_WATCHDOG_HOME"] = self.dir.name
        patcher = patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        hook = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "command-watchdog.py")
        spec = importlib.util.spec_from_file_location("cw_regex_original", hook)
        self.cw = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.cw)

    def test_rule_matches_original_text_not_rewritten_command(self):
        run, cmd = self.cw.configure_run(["--original", "run-wd-original-marker", "--", "rtk proxy ls"])
        self.assertEqual(cmd, "rtk proxy ls")
        self.assertEqual(run.rule_key, "rule:original-only")
        self.assertEqual(self.cw.IDLE_LIMIT, 7)

    def test_rewritten_command_text_does_not_select_the_rule(self):
        run, cmd = self.cw.configure_run(["--original", "ls", "--", "echo wd-original-marker"])
        self.assertEqual(cmd, "echo wd-original-marker")
        self.assertNotEqual(run.rule_key, "rule:original-only")
        self.assertNotEqual(self.cw.IDLE_LIMIT, 7)

    def test_rtk_decision_call_does_not_take_a_matching_rule(self):
        run, _ = self.cw.configure_run(["--rtk-decision", "--", "echo wd-original-marker"])
        self.assertTrue(run.rtk_decision)
        self.assertNotEqual(run.rule_key, "rule:original-only")


if __name__ == "__main__":
    unittest.main()
