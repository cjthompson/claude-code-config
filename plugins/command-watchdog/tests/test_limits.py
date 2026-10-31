import os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WATCHDOG = os.path.join(HERE, "..", "hooks", "command-watchdog.py")
ENV = dict(os.environ, WATCHDOG_POLL="1")


# Isolate every test in this module from the user's real data directory: rule_paths() reads the
# data-directory INI and an enabled store would record real rows (ruling R20, as in test_hook.py).
_HOME = None
_SAVED_HOME = None


def setUpModule():
    global _HOME, _SAVED_HOME
    _HOME = tempfile.TemporaryDirectory()
    _SAVED_HOME = os.environ.get("COMMAND_WATCHDOG_HOME")
    os.environ["COMMAND_WATCHDOG_HOME"] = _HOME.name
    ENV["COMMAND_WATCHDOG_HOME"] = _HOME.name


def tearDownModule():
    if _SAVED_HOME is None:
        os.environ.pop("COMMAND_WATCHDOG_HOME", None)
    else:
        os.environ["COMMAND_WATCHDOG_HOME"] = _SAVED_HOME
    ENV.pop("COMMAND_WATCHDOG_HOME", None)
    if _SAVED_HOME is not None:
        ENV["COMMAND_WATCHDOG_HOME"] = _SAVED_HOME
    _HOME.cleanup()


def run_watchdog(args, env=None, timeout=30):
    return subprocess.run(["/usr/bin/python3", WATCHDOG] + args, capture_output=True, text=True,
                          env=env or ENV, timeout=timeout)


class LimitTests(unittest.TestCase):
    def test_set_idle_triggers_kill_then_off_does_not(self):
        killed = run_watchdog(["--set", "idle=2", "--", "sh", "-c", "sleep 30"])
        self.assertEqual(killed.returncode, 124)
        self.assertIn("HANG DETECTED (idle)", killed.stdout + killed.stderr)
        survived = run_watchdog(["--set", "idle=off", "--", "sh", "-c", "sleep 4; echo done"])
        self.assertEqual(survived.returncode, 0)
        self.assertIn("done", survived.stdout)

    def test_invalid_set_value_falls_through_to_default(self):
        result = run_watchdog(["--set", "idle=0", "--", "echo", "ok"])
        self.assertEqual(result.returncode, 0)
        self.assertIn("ok", result.stdout)

    def test_env_idle_off_disables_idle_kill_without_crashing(self):
        result = run_watchdog(["--", "sh", "-c", "sleep 3; echo done"], env=dict(ENV, WATCHDOG_IDLE="off"))
        self.assertEqual(result.returncode, 0)
        self.assertIn("done", result.stdout)

    def test_malformed_env_degrades_to_defaults(self):
        for name, value in (("WATCHDOG_IDLE", "abc"), ("WATCHDOG_POLL", "abc"), ("WATCHDOG_POLL_CAP", "off"),
                            ("WATCHDOG_MAX_RUNTIME", "abc")):
            with self.subTest(name=name):
                result = run_watchdog(["--", "sh", "-c", "sleep 3; echo done"], env=dict(ENV, **{name: value}))
                self.assertEqual(result.returncode, 0)
                self.assertIn("done", result.stdout)

    def test_no_command_is_usage_error(self):
        self.assertEqual(run_watchdog(["--original", "x", "--"]).returncode, 2)

    def test_nice_off_keeps_inherited_priority(self):
        with tempfile.TemporaryDirectory() as home:
            with open(os.path.join(home, "watchdog-patterns.ini"), "w") as handle:
                handle.write("[command:python3]\nnice: off\n")
            env = dict(ENV, COMMAND_WATCHDOG_HOME=home)
            probe = "/usr/bin/python3 -c 'import os; print(os.getpriority(os.PRIO_PROCESS, 0))'"

            # An unprivileged process cannot lower its niceness, so the inherited value
            # must be at least the current one; skip when that cannot differ from the default.
            inherited = max(os.getpriority(os.PRIO_PROCESS, 0), 5)
            if inherited >= (20 if sys.platform == "darwin" else 19):
                self.skipTest("test process already at the lowest priority")

            def setup():
                os.setpriority(os.PRIO_PROCESS, 0, inherited)

            result = subprocess.run(["/usr/bin/python3", WATCHDOG, probe], capture_output=True, text=True,
                                    env=env, timeout=30, preexec_fn=setup)
            self.assertEqual(result.stdout.split(), [str(inherited)])


if __name__ == "__main__":
    unittest.main()
