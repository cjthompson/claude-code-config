import importlib.util, os, sqlite3, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))

WATCHDOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "command-watchdog.py")
spec = importlib.util.spec_from_file_location("command_watchdog", WATCHDOG)
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)


class LaunchFailureTimingTests(unittest.TestCase):
    def test_launch_failure_records_zero_execution_time(self):
        with tempfile.TemporaryDirectory() as home:
            saved = os.environ.get("COMMAND_WATCHDOG_HOME")
            os.environ["COMMAND_WATCHDOG_HOME"] = home
            try:
                path = cw.stats_store.db_path()
                cw.stats_store.enable(path)
                run = cw.RunState("no-such-binary", False)
                run.launch_failed = True
                cw.record_run_safely(run)
                conn = sqlite3.connect(path)
                try:
                    row = conn.execute("SELECT outcome, exit_code, execution_time FROM invocations").fetchone()
                finally:
                    conn.close()
            finally:
                if saved is None:
                    os.environ.pop("COMMAND_WATCHDOG_HOME", None)
                else:
                    os.environ["COMMAND_WATCHDOG_HOME"] = saved
        self.assertEqual(row, ("failed", 125, 0.0))


class ActivityTests(unittest.TestCase):
    def test_stale_event_does_not_move_last_activity_back(self):
        state = {"last_activity": 10.0}
        cw.record_activity(state, 4.0, None)
        self.assertEqual(state["last_activity"], 10.0)

    def test_silence_is_measured_from_the_latest_event(self):
        state = {"last_activity": 10.0}
        run = cw.RunState("x", False)
        cw.record_activity(state, 15.0, run)
        cw.record_activity(state, 12.0, run)  # a late timestamp from a slow sampler
        cw.record_activity(state, 18.0, run)
        self.assertEqual(state["last_activity"], 18.0)
        self.assertEqual(run.max_silence, 5.0)


class EndSilenceTests(unittest.TestCase):
    def test_trailing_gap_is_returned_and_counted_as_silence(self):
        state = {"last_activity": 10.0}
        run = cw.RunState("x", False)
        self.assertEqual(cw.end_silence(state, 14.0, run), 4.0)
        self.assertEqual(run.max_silence, 4.0)
        self.assertEqual(state["last_activity"], 14.0)

    def test_no_gap_when_the_mark_is_already_at_or_past_now(self):
        run = cw.RunState("x", False)
        self.assertEqual(cw.end_silence({"last_activity": 20.0}, 14.0, run), 0.0)
        self.assertEqual(run.max_silence, 0.0)


if __name__ == "__main__":
    unittest.main()
