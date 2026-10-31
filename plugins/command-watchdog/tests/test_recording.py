import contextlib
import io
import os
import sqlite3
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
WATCHDOG = os.path.join(HERE, "..", "hooks", "command-watchdog.py")
sys.path.insert(0, os.path.join(HERE, "..", "hooks"))
import stats_store as ss  # noqa: E402


def run_watchdog(home, args, timeout=30):
    env = dict(os.environ, COMMAND_WATCHDOG_HOME=home, WATCHDOG_POLL="1")
    return subprocess.run(["/usr/bin/python3", WATCHDOG] + args, capture_output=True, text=True,
                          env=env, timeout=timeout)


def rows(home, sql):
    conn = ss.connect(os.path.join(home, "stats.db"), readonly=True)
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


class RecordingTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.home = self.dir.name
        ss.enable(os.path.join(self.home, "stats.db"))

    def test_success_is_recorded(self):
        result = run_watchdog(self.home, ["--original", "echo hi", "--", "echo", "hi"])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(rows(self.home, "SELECT outcome, exit_code, primary_process FROM invocations"),
                         [("success", 0, "echo")])
        self.assertEqual(rows(self.home, "SELECT * FROM output_tail"), [])

    def test_idle_kill_is_recorded_with_tail(self):
        result = run_watchdog(self.home, ["--set", "idle=2", "--", "sh", "-c", "echo before; sleep 30"])
        self.assertEqual(result.returncode, 124)
        self.assertEqual(rows(self.home, "SELECT outcome, kill_reason, fired_check FROM invocations"),
                         [("killed", "idle", "idle")])
        self.assertGreaterEqual(len(rows(self.home, "SELECT * FROM output_tail")), 1)

    def test_failed_exit_is_recorded(self):
        run_watchdog(self.home, ["--", "sh", "-c", "echo noisy; exit 3"])
        self.assertEqual(rows(self.home, "SELECT outcome, exit_code FROM invocations"), [("failed", 3)])
        # The tail is persisted only for killed runs.
        self.assertEqual(rows(self.home, "SELECT * FROM output_tail"), [])

    def test_no_output_time_is_the_silence_at_exit(self):
        result = run_watchdog(self.home, ["--", "sh", "-c", "echo hi; sleep 2"])
        self.assertEqual(result.returncode, 0)
        [(no_output, max_silence)] = rows(self.home, "SELECT no_output_time, max_silence FROM invocations")
        self.assertGreater(no_output, 1.5)
        # The only silence in this run is the trailing gap, so both columns hold it.
        self.assertEqual(no_output, max_silence)

    def test_child_exit_125_and_130_are_failed_not_launch_or_cancel(self):
        for code in (125, 130):
            with self.subTest(code=code):
                result = run_watchdog(self.home, ["--", "sh", "-c", "exit {}".format(code)])
                self.assertEqual(result.returncode, code)
                self.assertEqual(rows(self.home, "SELECT outcome, exit_code, kill_reason, fired_check "
                                                 "FROM invocations ORDER BY id DESC LIMIT 1"),
                                 [("failed", code, None, "none")])

    def test_store_path_that_is_a_file_does_not_change_exit_status(self):
        blocked = os.path.join(self.home, "not-a-dir")
        with open(blocked, "w") as handle:
            handle.write("x")
        result = run_watchdog(blocked, ["--", "sh", "-c", "exit 7"])
        self.assertEqual(result.returncode, 7)

    def _load_hook(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("cw", WATCHDOG)
        cw = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cw)
        return cw

    def _run_main_capturing_fd1(self, cw, argv):
        """Run the real main() in-process; the hook writes command output straight to fd 1."""
        out_path = os.path.join(self.home, "captured-out")
        saved = os.dup(1)
        with open(out_path, "wb") as sink:
            os.dup2(sink.fileno(), 1)
            try:
                with patch.dict(os.environ, {"COMMAND_WATCHDOG_HOME": self.home, "WATCHDOG_POLL": "1"}), \
                        patch.object(sys, "argv", [WATCHDOG] + argv), \
                        contextlib.redirect_stderr(io.StringIO()):
                    code = cw.main()
            finally:
                os.dup2(saved, 1)
                os.close(saved)
        with open(out_path, "rb") as source:
            return code, source.read()

    def test_store_failing_at_write_time_does_not_change_exit_status_or_output(self):
        db = os.path.join(self.home, "stats.db")

        def make_readonly():
            os.chmod(db, 0o444)
            return lambda: os.chmod(db, 0o644)

        def make_locked():
            holder = sqlite3.connect(db, isolation_level=None)
            holder.execute("BEGIN EXCLUSIVE")
            return holder.close

        def make_corrupt():
            damaged = sqlite3.connect(db, isolation_level=None)
            damaged.execute("DROP TABLE invocations")
            damaged.close()
            return None

        for name, prepare in (("readonly", make_readonly), ("locked", make_locked), ("corrupt", make_corrupt)):
            with self.subTest(failure=name):
                os.unlink(db)
                for sidecar in (db + "-wal", db + "-shm"):
                    if os.path.exists(sidecar):
                        os.unlink(sidecar)
                # Each subtest must pass on its own log entry, never a stale one.
                try:
                    os.unlink(os.path.join(self.home, "debug.log"))
                except FileNotFoundError:
                    pass
                ss.enable(db)
                self.assertTrue(ss.is_enabled(db))  # the gate passes: the failure is at write time
                debug_flag = os.path.join(self.home, "debug.on")
                debug_log = os.path.join(self.home, "debug.log")
                open(debug_flag, "w").close()
                cw = self._load_hook()
                cw.DEBUG_FLAG, cw.DEBUG_LOG = debug_flag, debug_log
                restore = prepare()
                try:
                    # Probe: the write really does fail for this method.
                    with self.assertRaises(sqlite3.Error):
                        ss.record_run(db, ss.RunRecord(
                            started_at="2026-01-01T00:00:00+00:00", ended_at="2026-01-01T00:00:01+00:00",
                            command_line="x", primary_process="sh", signature="sh", loop_kind="none",
                            rule_key="global", ini_values={}, env_overrides=False, override_vars=(),
                            rtk_proxied=False, outcome="failed", kill_reason=None, fired_check="none",
                            exit_code=3, execution_time=1.0, cpu_time=0.0, max_silence=0.0,
                            no_output_time=0.0))
                    code, output = self._run_main_capturing_fd1(
                        cw, ["--", "sh", "-c", "echo out; exit 3"])
                finally:
                    if restore is not None:
                        restore()
                self.assertEqual(code, 3)
                self.assertEqual(output, b"out\n")
                with open(debug_log) as handle:
                    self.assertIn("stage='stats-write-failed'", handle.read())

    def test_disabled_collection_creates_nothing(self):
        other = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(other, ignore_errors=True))
        result = run_watchdog(other, ["--", "echo", "ok"])
        self.assertEqual(result.returncode, 0)
        self.assertFalse(os.path.exists(os.path.join(other, "stats.db")))

    def test_launch_failure_is_recorded_as_125(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("cw", WATCHDOG)
        cw = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cw)
        marker = os.path.join(self.home, "ran")
        with patch.dict(os.environ, {"COMMAND_WATCHDOG_HOME": self.home}), \
                patch.object(sys, "argv", [WATCHDOG, "touch " + shlex.quote(marker)]), \
                patch.object(cw.os, "setpriority", side_effect=PermissionError("denied")), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cw.main(), 125)
        self.assertFalse(os.path.exists(marker))
        self.assertEqual(rows(self.home, "SELECT outcome, exit_code FROM invocations"), [("failed", 125)])

    def test_cancellation_is_recorded_once_as_failed(self):
        proc = subprocess.Popen(["/usr/bin/python3", WATCHDOG, "--", "sh", "-c", "sleep 30"],
                                env=dict(os.environ, COMMAND_WATCHDOG_HOME=self.home, WATCHDOG_POLL="1"),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.5)
        proc.send_signal(signal.SIGTERM)
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=30)
        result = rows(self.home, "SELECT outcome, exit_code FROM invocations")
        self.assertEqual(result, [("failed", 128 + signal.SIGTERM)])

    def test_rtk_call_is_recorded_as_rtk(self):
        run_watchdog(self.home, ["--", "rtk", "hook", "claude"])
        self.assertEqual(rows(self.home, "SELECT primary_process, signature FROM invocations"),
                         [("rtk", "rtk hook")])

    def test_rtk_decision_call_is_not_recorded(self):
        # bash-watchdog's own rewrite lookup is not a user command, so it writes no stats row.
        run_watchdog(self.home, ["--rtk-decision", "--", "rtk", "hook", "claude"])
        self.assertEqual(rows(self.home, "SELECT * FROM invocations"), [])

    def test_watchdog_kill_is_recorded_with_the_code_the_caller_saw(self):
        result = run_watchdog(self.home, ["--set", "idle=1", "--", "sleep 30"])
        self.assertEqual(result.returncode, 124)
        self.assertEqual(rows(self.home, "SELECT outcome, kill_reason, exit_code FROM invocations"),
                         [("killed", "idle", 124)])


if __name__ == "__main__":
    unittest.main()
