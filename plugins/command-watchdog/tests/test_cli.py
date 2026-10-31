import configparser, glob, os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "bin", "command-watchdog-stats")
sys.path.insert(0, os.path.join(HERE, "..", "hooks"))
import stats_store as ss
from stats_store import RunRecord


def cli(home, *args):
    env = dict(os.environ, COMMAND_WATCHDOG_HOME=home)
    return subprocess.run(["/usr/bin/python3", CLI] + list(args), capture_output=True, text=True, env=env)


def seed(home, n_ok=5, kills=0, rule_key="command:make", signature="make"):
    path = os.path.join(home, "stats.db")
    ss.enable(path)
    base = dict(started_at="2026-10-14T10:00:00+00:00", ended_at="2026-10-14T10:00:02+00:00",
                command_line="make", primary_process="make", signature=signature, loop_kind="none",
                rule_key=rule_key, ini_values={"idle": 300}, env_overrides=False,
                override_vars=(), rtk_proxied=False, exit_code=0, execution_time=2.0, cpu_time=1.0,
                max_silence=30.0, no_output_time=0.5)
    for _ in range(n_ok):
        ss.record_run(path, RunRecord(outcome="success", kill_reason=None, fired_check="none", **base))
    for _ in range(kills):
        ss.record_run(path, RunRecord(outcome="killed", kill_reason="idle", fired_check="idle",
                                      **dict(base, exit_code=None)))


class SharedParserTests(unittest.TestCase):
    def test_cli_reads_rule_files_with_the_hook_factory(self):
        import importlib.machinery, importlib.util
        import watchdog_config
        loader = importlib.machinery.SourceFileLoader("command_watchdog_stats_cli", CLI)
        spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        self.assertIs(module.new_parser, watchdog_config.new_parser,
                      msg="the CLI must not keep its own copy of the rule-file parser setup")


class CliTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = self.dir.name

    def ini(self):
        return os.path.join(self.home, "watchdog-patterns.ini")

    def test_stats_disabled_prompts_and_creates_nothing(self):
        result = cli(self.home, "stats")
        self.assertEqual(result.returncode, 0)
        self.assertIn("stats disabled. Do you want to enable stats collection?", result.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.home, "stats.db")))

    def test_enable_is_idempotent(self):
        self.assertEqual(cli(self.home, "enable-stats").returncode, 0)
        self.assertEqual(cli(self.home, "enable-stats").returncode, 0)
        self.assertTrue(os.path.exists(os.path.join(self.home, "stats.db")))

    def test_stats_prints_totals(self):
        seed(self.home, n_ok=3)
        result = cli(self.home, "stats")
        self.assertEqual(result.returncode, 0)
        self.assertIn("invocations: 3", result.stdout)

    def test_suggest_without_section_lists_sections(self):
        seed(self.home)
        result = cli(self.home, "suggest-timeouts")
        self.assertIn("command:make", result.stdout)

    def test_suggest_section_prints_three_options_per_check(self):
        seed(self.home)
        result = cli(self.home, "suggest-timeouts", "command:make")
        self.assertEqual(result.returncode, 0)
        for word in ("tight", "medium", "long"):
            self.assertIn(word, result.stdout)

    def test_apply_requires_choose(self):
        seed(self.home)
        self.assertEqual(cli(self.home, "suggest-timeouts", "command:make", "--apply").returncode, 2)
        self.assertFalse(os.path.exists(self.ini()))

    def test_apply_writes_chosen_value_and_backup(self):
        seed(self.home)
        result = cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        self.assertEqual(result.returncode, 0)
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(self.ini())
        self.assertTrue(parser.has_option("command:make", "idle"))
        self.assertEqual(glob.glob(os.path.join(self.home, "watchdog-patterns.ini.bak-*")), [])

    def test_second_apply_keeps_backup(self):
        seed(self.home)
        cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=long", "--apply")
        self.assertEqual(len(glob.glob(os.path.join(self.home, "watchdog-patterns.ini.bak-*"))), 1)

    def test_reset_refuses_without_yes(self):
        seed(self.home)
        self.assertEqual(cli(self.home, "reset-stats").returncode, 2)

    def test_reset_with_yes_backs_up_and_clears(self):
        seed(self.home, n_ok=2)
        self.assertEqual(cli(self.home, "reset-stats", "--yes").returncode, 0)
        self.assertEqual(len(glob.glob(os.path.join(self.home, "stats-backup-*.db"))), 1)
        self.assertIn("invocations: 0", cli(self.home, "stats").stdout)

    def test_delete_requires_all_and_yes(self):
        seed(self.home)
        self.assertEqual(cli(self.home, "delete-stats", "--yes").returncode, 2)
        self.assertEqual(cli(self.home, "delete-stats", "--all", "--yes").returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(self.home, "stats.db")))


class ReadOnlyAndRefusalTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = os.path.join(self.dir.name, "missing-store-dir")  # does not exist yet

    def test_read_commands_never_create_the_store_directory(self):
        for args in (("stats",), ("suggest-timeouts",), ("suggest-timeouts", "command:make"),
                     ("suggest-timeouts", "command:make", "--choose", "idle=tight")):
            result = cli(self.home, *args)
            self.assertEqual(result.returncode, 0, args)
            self.assertIn("stats disabled. Do you want to enable stats collection?", result.stdout)
            self.assertFalse(os.path.exists(self.home), args)

    def test_apply_while_disabled_writes_nothing(self):
        result = cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        self.assertEqual(result.returncode, 0)
        self.assertIn("stats disabled", result.stdout)
        self.assertFalse(os.path.exists(self.home))

    def test_apply_usage_errors_come_before_the_disabled_check(self):
        self.assertEqual(cli(self.home, "suggest-timeouts", "command:make", "--apply").returncode, 2)
        self.assertEqual(cli(self.home, "suggest-timeouts", "--choose", "idle=tight", "--apply").returncode, 2)
        self.assertFalse(os.path.exists(self.home))

    def test_reset_and_delete_on_disabled_store_create_nothing(self):
        self.assertEqual(cli(self.home, "reset-stats", "--yes").returncode, 0)
        self.assertEqual(cli(self.home, "delete-stats", "--all", "--yes").returncode, 0)
        self.assertFalse(os.path.exists(self.home))

    def test_stats_does_not_create_database_or_alter_it(self):
        os.makedirs(self.home)
        self.assertEqual(cli(self.home, "stats").returncode, 0)
        self.assertEqual(os.listdir(self.home), [])


class ApplyTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = self.dir.name
        self.ini = os.path.join(self.home, "watchdog-patterns.ini")
        seed(self.home)

    def read(self):
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(self.ini)
        return parser

    def backups(self):
        return sorted(glob.glob(os.path.join(self.home, "watchdog-patterns.ini.bak-*")))

    def test_preview_writes_nothing_and_shows_the_change(self):
        result = cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight")
        self.assertEqual(result.returncode, 0)
        self.assertIn("+idle = 40", result.stdout)
        self.assertFalse(os.path.exists(self.ini))
        self.assertFalse([n for n in os.listdir(self.home) if not n.startswith("stats.db")])

    def test_apply_writes_only_the_named_choices(self):
        result = cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        self.assertEqual(result.returncode, 0)
        parser = self.read()
        self.assertEqual(parser.sections(), ["command:make"])
        self.assertEqual(dict(parser["command:make"]), {"idle": "40"})

    def test_apply_keeps_other_sections_and_keys_and_backs_up_comments(self):
        original = "# my comment\n[global]\nidle: 120\n\n[command:make]\nnice: off\n"
        with open(self.ini, "w") as handle:
            handle.write(original)
        result = cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=medium", "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        parser = self.read()
        self.assertEqual(parser["global"]["idle"], "120")
        self.assertEqual(parser["command:make"]["nice"], "off")
        self.assertIn("idle", parser["command:make"])
        with open(self.ini) as handle:
            self.assertNotIn("# my comment", handle.read())
        backups = self.backups()
        self.assertEqual(len(backups), 1)
        with open(backups[0]) as handle:
            self.assertEqual(handle.read(), original)

    def test_existing_backup_is_never_overwritten(self):
        with open(self.ini, "w") as handle:
            handle.write("[global]\nidle: 120\n")
        stamp = __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
        # Pre-claim every plausible stamp for the next 3 seconds so a collision is certain.
        planted = []
        for offset in range(-1, 4):
            moment = stamp + __import__("datetime").timedelta(seconds=offset)
            name = os.path.join(self.home, "watchdog-patterns.ini.bak-" + moment.strftime("%Y%m%d-%H%M%S"))
            with open(name, "w") as handle:
                handle.write("PLANTED")
            planted.append(name)
        result = cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in planted:
            with open(name) as handle:
                self.assertEqual(handle.read(), "PLANTED")
        self.assertEqual(len(self.backups()), len(planted) + 1)

    def test_unknown_check_option_or_syntax_is_a_usage_error_and_writes_nothing(self):
        for choose in ("poll=tight", "nice=on", "idle=huge", "idle", "idle=tight,idle=long", "bogus=tight", ""):
            result = cli(self.home, "suggest-timeouts", "command:make", "--choose", choose, "--apply")
            self.assertEqual(result.returncode, 2, choose)
        self.assertFalse(os.path.exists(self.ini))

    def test_choosing_a_check_with_no_options_is_a_usage_error(self):
        # poll_cap has no untargeted runs in the seed data, so it offers no options.
        result = cli(self.home, "suggest-timeouts", "command:make", "--choose", "poll_cap=tight", "--apply")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(os.path.exists(self.ini))

    def test_apply_with_no_data_for_section_is_refused(self):
        result = cli(self.home, "suggest-timeouts", "command:nothing", "--choose", "idle=tight", "--apply")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(os.path.exists(self.ini))
        read = cli(self.home, "suggest-timeouts", "command:nothing")
        self.assertEqual(read.returncode, 0)
        self.assertIn("no data for command:nothing", read.stdout)

    def test_unparseable_ini_is_not_overwritten(self):
        with open(self.ini, "w") as handle:
            handle.write("this is not an ini\n")
        result = cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        self.assertEqual(result.returncode, 1)
        with open(self.ini) as handle:
            self.assertEqual(handle.read(), "this is not an ini\n")
        self.assertEqual(self.backups(), [])

    def test_symlinked_ini_is_refused(self):
        target = os.path.join(self.dir.name + "-elsewhere.ini")
        with open(target, "w") as handle:
            handle.write("[global]\nidle: 1\n")
        self.addCleanup(os.unlink, target)
        os.symlink(target, self.ini)
        result = cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        self.assertEqual(result.returncode, 1)
        with open(target) as handle:
            self.assertEqual(handle.read(), "[global]\nidle: 1\n")

    def test_rule_section_with_regex_only_in_plugin_file_is_refused(self):
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        seed(other.name, rule_key="rule:shell-scripts", signature="bash")  # regex lives in the plugin ini only
        ini = os.path.join(other.name, "watchdog-patterns.ini")
        original = "# keep me\n[global]\nidle: 120\n"
        with open(ini, "w") as handle:
            handle.write(original)
        for extra in ((), ("--apply",)):
            result = cli(other.name, "suggest-timeouts", "rule:shell-scripts", "--choose", "idle=tight", *extra)
            self.assertEqual(result.returncode, 1, extra)
            self.assertIn("defined only in the plugin file", result.stderr)
        with open(ini) as handle:
            self.assertEqual(handle.read(), original)
        self.assertEqual(glob.glob(ini + ".bak-*"), [])

    def test_rule_section_with_own_regex_gets_only_the_chosen_key(self):
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        seed(other.name, rule_key="rule:shell-scripts", signature="bash")
        ini = os.path.join(other.name, "watchdog-patterns.ini")
        with open(ini, "w") as handle:
            handle.write("[rule:shell-scripts]\nregex: \\.sh\\b\nnice: off\n")
        result = cli(other.name, "suggest-timeouts", "rule:shell-scripts", "--choose", "idle=tight", "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(ini)
        self.assertEqual(dict(parser["rule:shell-scripts"]),
                         {"regex": r"\.sh\b", "nice": "off", "idle": "40"})
        self.assertEqual(len(glob.glob(ini + ".bak-*")), 1)

    def test_default_section_is_not_copied_into_other_sections(self):
        original = ("[DEFAULT]\nnice = off\n\n[global]\nidle: 120\n\n[command:git]\nidle: 60\n")
        with open(self.ini, "w") as handle:
            handle.write(original)
        before = self.sections_of(self.ini)
        result = cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("nice", result.stdout.split("preview:")[1])
        after = self.sections_of(self.ini)
        self.assertEqual(after["global"], before["global"])
        self.assertEqual(after["command:git"], before["command:git"])
        self.assertEqual(after["DEFAULT"], {"nice": "off"})
        self.assertEqual(after["command:make"], {"idle": "40"})
        self.assertEqual(set(after), set(before) | {"command:make"})

    def test_default_section_still_applies_at_runtime_after_apply(self):
        with open(self.ini, "w") as handle:
            handle.write("[DEFAULT]\nnice = off\n\n[global]\nidle: 120\n")
        self.assertEqual(cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight",
                             "--apply").returncode, 0)
        import watchdog_config as wc
        rules, warnings = wc.load_rules([self.ini])
        self.assertEqual(warnings, [])
        self.assertIs(rules.global_values["nice"], False)
        # The DEFAULT value reaches make through [global], not by being copied into its section.
        self.assertEqual(rules.commands["make"], {"idle": 40})

    @staticmethod
    def sections_of(path):
        parser = configparser.ConfigParser(interpolation=None, default_section="\x00none")
        parser.read(path)
        return {name: dict(parser[name]) for name in parser.sections()}

    def test_unknown_rule_section_is_refused_instead_of_writing_a_match_all_rule(self):
        other = tempfile.TemporaryDirectory()
        self.addCleanup(other.cleanup)
        seed(other.name, rule_key="rule:vanished", signature="bash")
        result = cli(other.name, "suggest-timeouts", "rule:vanished", "--choose", "idle=tight", "--apply")
        self.assertEqual(result.returncode, 1)
        self.assertFalse(os.path.exists(os.path.join(other.name, "watchdog-patterns.ini")))

    def test_no_stray_files_remain_after_apply(self):
        cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        names = set(os.listdir(self.home))
        self.assertFalse([n for n in names if n.endswith(".tmp")])


class StoreErrorTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = self.dir.name
        self.db = os.path.join(self.home, "stats.db")

    def test_corrupt_store_is_reported_with_exit_1_and_enable_does_not_overwrite(self):
        with open(self.db, "wb") as handle:
            handle.write(b"not a database")
        for args in (("stats",), ("suggest-timeouts",), ("reset-stats", "--yes"), ("enable-stats",)):
            self.assertEqual(cli(self.home, *args).returncode, 1, args)
        with open(self.db, "rb") as handle:
            self.assertEqual(handle.read(), b"not a database")
        self.assertEqual(glob.glob(os.path.join(self.home, "stats-backup-*")), [])

    def test_delete_removes_a_corrupt_store_and_backups_but_leaves_the_ini(self):
        with open(self.db, "wb") as handle:
            handle.write(b"junk")
        for name in ("stats-backup-20260101-000000.db", "watchdog-patterns.ini",
                     "watchdog-patterns.ini.bak-20260101-000000"):
            with open(os.path.join(self.home, name), "w") as handle:
                handle.write("x")
        self.assertEqual(cli(self.home, "delete-stats", "--all", "--yes").returncode, 0)
        self.assertEqual(sorted(os.listdir(self.home)),
                         ["watchdog-patterns.ini", "watchdog-patterns.ini.bak-20260101-000000"])

    def test_no_subcommand_is_a_usage_error(self):
        self.assertEqual(cli(self.home).returncode, 2)


class StatsOutputTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = self.dir.name

    def test_stats_shows_outcomes_kills_and_rule_sections(self):
        seed(self.home, n_ok=3, kills=1)
        out = cli(self.home, "stats").stdout
        for text in ("invocations: 4", "successful: 3", "killed: 1", "kill reason idle: 1",
                     "rule command:make", "version 1"):
            self.assertIn(text, out)

    def test_suggest_lists_sections_and_skips_rtk(self):
        seed(self.home, rule_key="command:rtk", signature="rtk")
        out = cli(self.home, "suggest-timeouts").stdout
        self.assertNotIn("command:rtk  ", out)
        explicit = cli(self.home, "suggest-timeouts", "rtk")
        self.assertEqual(explicit.returncode, 0)
        self.assertIn("tight", explicit.stdout)


def seed_overridden(home, count, override_vars, rule_key="command:make", signature="make"):
    """Record COUNT runs excluded from suggestions by the named override variables."""
    path = os.path.join(home, "stats.db")
    ss.enable(path)
    for _ in range(count):
        ss.record_run(path, RunRecord(
            started_at="2026-10-14T10:00:00+00:00", ended_at="2026-10-14T10:00:02+00:00",
            command_line="make", primary_process="make", signature=signature, loop_kind="none",
            rule_key=rule_key, ini_values={"idle": 300}, env_overrides=True, override_vars=override_vars,
            rtk_proxied=False, outcome="success", kill_reason=None, fired_check="none", exit_code=0,
            execution_time=2.0, cpu_time=1.0, max_silence=30.0, no_output_time=0.5))


class OverrideNamingTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = self.dir.name

    def test_stats_names_the_variable_behind_excluded_runs(self):
        seed(self.home, n_ok=2)
        seed_overridden(self.home, 3, ("WATCHDOG_IDLE",))
        out = cli(self.home, "stats").stdout
        self.assertIn("overridden runs: 3", out)
        self.assertIn("WATCHDOG_IDLE: 3", out)

    def test_suggest_section_names_the_variable_behind_excluded_runs(self):
        seed(self.home, n_ok=2)
        seed_overridden(self.home, 3, ("WATCHDOG_IDLE",))
        seed_overridden(self.home, 1, ("WATCHDOG_IDLE", "WATCHDOG_MAX_RUNTIME"))
        result = cli(self.home, "suggest-timeouts", "command:make")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("excluded 4 run(s) with overrides: WATCHDOG_IDLE (4), WATCHDOG_MAX_RUNTIME (1)",
                      result.stdout)

    def test_suggest_list_names_the_variable(self):
        seed(self.home, n_ok=2)
        seed_overridden(self.home, 2, ("WATCHDOG_IDLE",))
        out = cli(self.home, "suggest-timeouts").stdout
        self.assertIn("command:make  (2 runs; excluded 2 run(s) with overrides: WATCHDOG_IDLE (2))", out)

    def test_section_with_only_overridden_runs_is_listed_not_silently_empty(self):
        seed_overridden(self.home, 5, ("WATCHDOG_IDLE",), rule_key="command:npm", signature="npm")
        listing = cli(self.home, "suggest-timeouts")
        self.assertEqual(listing.returncode, 0, listing.stderr)
        self.assertIn("command:npm  (0 runs; excluded 5 run(s) with overrides: WATCHDOG_IDLE (5))",
                      listing.stdout)
        section = cli(self.home, "suggest-timeouts", "npm")
        self.assertEqual(section.returncode, 0, section.stderr)
        self.assertIn("no data for command:npm", section.stdout)
        self.assertIn("excluded 5 run(s) with overrides: WATCHDOG_IDLE (5)", section.stdout)

    def test_suggest_without_overrides_prints_no_excluded_line(self):
        seed(self.home, n_ok=2)
        self.assertNotIn("excluded", cli(self.home, "suggest-timeouts", "command:make").stdout)


class NoChangeApplyTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = self.dir.name
        self.ini = os.path.join(self.home, "watchdog-patterns.ini")
        seed(self.home)

    def test_apply_with_empty_diff_writes_nothing_and_makes_no_backup(self):
        first = cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        self.assertEqual(first.returncode, 0, first.stderr)
        before = os.stat(self.ini)
        with open(self.ini) as handle:
            content = handle.read()
        second = cli(self.home, "suggest-timeouts", "command:make", "--choose", "idle=tight", "--apply")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("(no change)", second.stdout)
        self.assertNotIn("wrote", second.stdout)
        self.assertEqual(glob.glob(self.ini + ".bak-*"), [])
        after = os.stat(self.ini)
        self.assertEqual((after.st_ino, after.st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        with open(self.ini) as handle:
            self.assertEqual(handle.read(), content)
        self.assertFalse([n for n in os.listdir(self.home) if n.endswith(".tmp")])


if __name__ == "__main__":
    unittest.main()
