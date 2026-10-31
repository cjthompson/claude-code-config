"""Priority tests for command-watchdog.py.

Run: /usr/bin/python3 -m unittest discover -s plugins/command-watchdog/tests -v
"""
import contextlib
import importlib.util
import io
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

WATCHDOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "command-watchdog.py")
PROBE = "/usr/bin/python3 -c 'import os; print(os.getpriority(os.PRIO_PROCESS, 0))'"
LOWEST_NICE = 20 if sys.platform == "darwin" else 19

spec = importlib.util.spec_from_file_location("command_watchdog", WATCHDOG)
assert spec is not None and spec.loader is not None
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)


# Isolate every test in this module from the user's real data directory: rule_paths() reads the
# data-directory INI and an enabled store would record real rows (ruling R20, as in test_hook.py).
_HOME = None
_SAVED_HOME = None


def setUpModule():
    global _HOME, _SAVED_HOME
    _HOME = tempfile.TemporaryDirectory()
    _SAVED_HOME = os.environ.get("COMMAND_WATCHDOG_HOME")
    os.environ["COMMAND_WATCHDOG_HOME"] = _HOME.name


def tearDownModule():
    if _SAVED_HOME is None:
        os.environ.pop("COMMAND_WATCHDOG_HOME", None)
    else:
        os.environ["COMMAND_WATCHDOG_HOME"] = _SAVED_HOME
    _HOME.cleanup()


def nice_of(cmd, inherited_nice=None, **env):
    def setup():
        if inherited_nice is not None:
            os.setpriority(os.PRIO_PROCESS, 0, inherited_nice)

    r = subprocess.run(
        ["/usr/bin/python3", WATCHDOG, cmd],
        capture_output=True, text=True, env=dict(os.environ, **env), timeout=30,
        preexec_fn=setup,
    )
    if r.returncode != 0:
        raise AssertionError("watchdog failed: {}".format(r.stderr))
    return [int(x) for x in r.stdout.split()]


class NiceTests(unittest.TestCase):
    def test_child_and_descendants_default_to_lowest_priority(self):
        self.assertEqual(nice_of(PROBE + "; /bin/sh -c " + shlex.quote(PROBE)), [LOWEST_NICE, LOWEST_NICE])

    def test_environment_cannot_raise_task_priority(self):
        for value in ("0", "5", "-20", "invalid"):
            with self.subTest(value=value):
                self.assertEqual(nice_of(PROBE, WATCHDOG_NICE=value), [LOWEST_NICE])

    def test_parent_already_at_lowest_priority_can_run_task(self):
        self.assertEqual(nice_of(PROBE, inherited_nice=LOWEST_NICE), [LOWEST_NICE])

    @unittest.skipUnless(sys.platform == "darwin", "macOS niceness range")
    @unittest.skipIf(os.getpriority(os.PRIO_PROCESS, 0) > 19,
                     "test runner inherited niceness above 19; an unprivileged process cannot set 19 (R31)")
    def test_parent_at_nineteen_is_lowered_to_twenty(self):
        self.assertEqual(nice_of(PROBE, inherited_nice=19), [20])

    def test_nice_off_in_ini_is_not_a_priority_refusal(self):
        import tempfile as _tf
        with _tf.TemporaryDirectory() as home:
            with open(os.path.join(home, "watchdog-patterns.ini"), "w") as handle:
                handle.write("[command:python3]\nnice: off\n")
            env = dict(os.environ, COMMAND_WATCHDOG_HOME=home)
            r = subprocess.run(["/usr/bin/python3", WATCHDOG, PROBE], capture_output=True, text=True,
                               env=env, timeout=30)
            self.assertEqual(r.returncode, 0)

    def test_nice_off_never_calls_setpriority(self):
        # In-process, so it holds even when the test process is already at the lowest priority.
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as directory:
            with open(os.path.join(home, "watchdog-patterns.ini"), "w") as handle:
                handle.write("[command:touch]\nnice: off\n")
            marker = os.path.join(directory, "task-ran")
            saved_env = os.environ.get("COMMAND_WATCHDOG_HOME")
            saved_enabled = cw.NICE_ENABLED
            os.environ["COMMAND_WATCHDOG_HOME"] = home
            try:
                with patch.object(sys, "argv", [WATCHDOG, "touch " + shlex.quote(marker)]), \
                        patch.object(cw.os, "setpriority", side_effect=PermissionError("denied")):
                    self.assertEqual(cw.main(), 0)
                self.assertTrue(os.path.exists(marker))
            finally:
                cw.NICE_ENABLED = saved_enabled
                if saved_env is None:
                    os.environ.pop("COMMAND_WATCHDOG_HOME", None)
                else:
                    os.environ["COMMAND_WATCHDOG_HOME"] = saved_env

    def test_priority_failure_prevents_task_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = os.path.join(directory, "task-ran")
            stderr = io.StringIO()
            with patch.object(sys, "argv", [WATCHDOG, "touch " + shlex.quote(marker)]), \
                    patch.object(cw.os, "setpriority", side_effect=PermissionError("denied")), \
                    contextlib.redirect_stderr(stderr):
                self.assertEqual(cw.main(), 125)
            self.assertFalse(os.path.exists(marker))
            self.assertIn("command-watchdog: unable to start command", stderr.getvalue())
            self.assertIn("denied", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
