import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
import watchdog_config
from command_identity import LIFTABLE, lift_overrides, primary_process, signature


class OverrideTableTests(unittest.TestCase):
    def test_lift_table_is_derived_from_config(self):
        self.assertEqual(LIFTABLE, {watchdog_config.ENV_NAMES[key]: key
                                    for key in watchdog_config.LIFTABLE_KEYS})

    def test_poll_is_env_only_and_stays_in_the_command(self):
        self.assertEqual(lift_overrides("WATCHDOG_POLL=1 npm test"),
                         ({}, [], "WATCHDOG_POLL=1 npm test"))


class LiftTests(unittest.TestCase):
    def test_lifts_listed_key(self):
        self.assertEqual(lift_overrides("WATCHDOG_IDLE=600 npm test"), ({"idle": "600"}, [], "npm test"))

    def test_assignment_only_leaves_nothing(self):
        self.assertEqual(lift_overrides("WATCHDOG_IDLE=600"), ({"idle": "600"}, [], ""))

    def test_rejects_bad_value(self):
        self.assertEqual(lift_overrides("WATCHDOG_IDLE=abc npm test"), ({}, ["WATCHDOG_IDLE=abc"], "WATCHDOG_IDLE=abc npm test"))

    def test_keeps_unlisted_watchdog_name(self):
        self.assertEqual(lift_overrides("WATCHDOG_NICE=off npm test"), ({}, [], "WATCHDOG_NICE=off npm test"))

    def test_accepts_negative_one_and_keeps_other_assignments(self):
        self.assertEqual(lift_overrides("WATCHDOG_MAX_RUNTIME=-1 FOO=1 make"),
                         ({"max_runtime": "-1"}, [], "FOO=1 make"))

    def test_keeps_every_other_byte(self):
        cases = {
            'WATCHDOG_IDLE=5  FOO="a  b" sh -c x': ({"idle": "5"}, [], 'FOO="a  b" sh -c x'),
            'FOO="a  b" WATCHDOG_IDLE=5 sh -c x': ({"idle": "5"}, [], 'FOO="a  b" sh -c x'),
            "FOO=1\nprintf x": ({}, [], "FOO=1\nprintf x"),
            "WATCHDOG_IDLE=5\nnpm test": ({}, [], "WATCHDOG_IDLE=5\nnpm test"),
            "WATCHDOG_IDLE=600 && echo hi": ({}, [], "WATCHDOG_IDLE=600 && echo hi"),
            "WATCHDOG_IDLE=5 ; echo hi": ({}, [], "WATCHDOG_IDLE=5 ; echo hi"),
            "WATCHDOG_IDLE=5 WATCHDOG_MAX_RUNTIME=9 || x": ({"idle": "5"}, [], "WATCHDOG_MAX_RUNTIME=9 || x"),
            'FOO="x WATCHDOG_IDLE=5 y" run': ({}, [], 'FOO="x WATCHDOG_IDLE=5 y" run'),
            "WATCHDOG_IDLE=5 npm  test\n": ({"idle": "5"}, [], "npm  test\n"),
            "": ({}, [], ""),
            'WATCHDOG_IDLE="a WATCHDOG_MAX_RUNTIME=5 b" npm test':
                ({}, ['WATCHDOG_IDLE="a'], 'WATCHDOG_IDLE="a WATCHDOG_MAX_RUNTIME=5 b" npm test'),
            "WATCHDOG_IDLE=$(echo WATCHDOG_MAX_RUNTIME=5 ) npm test":
                ({}, ["WATCHDOG_IDLE=$(echo"], "WATCHDOG_IDLE=$(echo WATCHDOG_MAX_RUNTIME=5 ) npm test"),
            "WATCHDOG_IDLE=a\\ WATCHDOG_MAX_RUNTIME=5 npm test":
                ({}, ["WATCHDOG_IDLE=a\\"], "WATCHDOG_IDLE=a\\ WATCHDOG_MAX_RUNTIME=5 npm test"),
        }
        for command, expected in cases.items():
            with self.subTest(command=command):
                self.assertEqual(lift_overrides(command), expected)


class LiftRegressionTests(unittest.TestCase):
    def test_lifts_past_a_quoted_unlisted_assignment(self):
        self.assertEqual(lift_overrides('NODE_OPTIONS="--x=1" WATCHDOG_IDLE=600 npm test'),
                         ({"idle": "600"}, [], 'NODE_OPTIONS="--x=1" npm test'))

    def test_lifts_after_a_cd_prefix(self):
        self.assertEqual(lift_overrides("cd /tmp && WATCHDOG_IDLE=600 npm test"),
                         ({"idle": "600"}, [], "cd /tmp && npm test"))

    def test_cd_prefix_with_only_assignments_is_left_alone(self):
        self.assertEqual(lift_overrides("cd /tmp && WATCHDOG_IDLE=600"),
                         ({}, [], "cd /tmp && WATCHDOG_IDLE=600"))

    def test_reports_override_stranded_after_an_expansion(self):
        self.assertEqual(lift_overrides("FOO=$(date) WATCHDOG_IDLE=5 npm test"),
                         ({}, ["WATCHDOG_IDLE=5"], "FOO=$(date) WATCHDOG_IDLE=5 npm test"))


class PrimaryTests(unittest.TestCase):
    def test_cases(self):
        cases = {
            "FOO=1 npm run build": "npm",
            "cd x && npm test": "npm",
            "bash -c 'npm test'": "npm",
            "bin/rspec spec": "rspec",
            "rtk hook claude": "rtk",
            "rtk git status": "git",
            "bundle exec rspec": "rspec",
            "timeout 5 make": "make",
            "timeout -s KILL 10 npm test": "npm",
            "timeout --signal=KILL 10 npm test": "npm",
            "timeout -k 5 10 npm test": "npm",
            "": "",
        }
        for cmd, expected in cases.items():
            with self.subTest(cmd=cmd):
                self.assertEqual(primary_process(cmd), expected)


class SignatureTests(unittest.TestCase):
    def test_cases(self):
        cases = {
            "npm run build -- --watch": "npm run build",
            "git -C dir status": "git status",
            "npm run -s build -- --watch": "npm run build",
            "docker compose -f x.yml up": "docker compose up",
            "bin/rails test": "rails test",
            "git --git-dir=.git log": "git log",
            "rtk hook claude": "rtk hook",
            "npm test": "npm test",
            "make": "make",
            "timeout -s KILL 10 npm test": "npm test",
            "npm run": "npm run",
        }
        for cmd, expected in cases.items():
            with self.subTest(cmd=cmd):
                self.assertEqual(signature(cmd), expected)

    def test_never_raises_on_malformed_input(self):
        for cmd in ['echo "unterminated', "echo $(date)", "a | b", "--", '"', "'", "cd", "&&", "  "]:
            with self.subTest(cmd=cmd):
                self.assertIsInstance(signature(cmd), str)
                self.assertIsInstance(primary_process(cmd), str)


if __name__ == "__main__":
    unittest.main()
