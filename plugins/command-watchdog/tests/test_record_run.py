import json, os, sqlite3, sys, tempfile, threading, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
import stats_store as ss
from stats_store import RunRecord


def rec(outcome="success", kill=None, fired="none", env=False, cfg=None, loop="none", tail=(), rule="global",
        exec_time=2.0, signature="npm test", rtk=False):
    return RunRecord(
        started_at="2026-10-14T10:00:00+00:00", ended_at="2026-10-14T10:00:02+00:00",
        command_line="npm test", primary_process="npm", signature=signature, loop_kind=loop,
        rule_key=rule, ini_values=cfg or {"idle": 90}, env_overrides=env,
        override_vars=("WATCHDOG_IDLE",) if env else (), rtk_proxied=rtk,
        outcome=outcome, kill_reason=kill, fired_check=fired, exit_code=0 if outcome == "success" else 1,
        execution_time=exec_time, cpu_time=1.0, max_silence=0.5, no_output_time=0.2,
        output_tail=tuple(tail),
    )


class RecordTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "stats.db")
        ss.enable(self.path)

    def one(self, sql, args=()):
        conn = ss.connect(self.path, readonly=True)
        try:
            return conn.execute(sql, args).fetchone()
        finally:
            conn.close()

    def test_counters_and_detail(self):
        ss.record_run(self.path, rec(exec_time=2.0))
        ss.record_run(self.path, rec(exec_time=5.0))
        ss.record_run(self.path, rec(outcome="killed", kill="idle", fired="idle", exec_time=9.0))
        g = self.one("SELECT invocations, successful, killed, execution_max, execution_sum FROM counters "
                     "WHERE scope='global' AND key=''")
        self.assertEqual(g, (3, 2, 1, 5.0, 7.0))
        r = self.one("SELECT killed_idle, rule_version FROM counters WHERE scope='rule' AND key='global'")
        self.assertEqual(r, (1, 1))
        k = self.one("SELECT killed FROM counters WHERE scope='kill_reason' AND key='idle'")
        self.assertEqual(k, (1,))

    def test_fired_check_counters_are_rule_scope_only(self):
        ss.record_run(self.path, rec(outcome="killed", kill="idle", fired="idle"))
        g = self.one("SELECT killed_idle, killed_max_runtime, killed_poll_cap FROM counters "
                     "WHERE scope='global' AND key=''")
        self.assertEqual(g, (0, 0, 0))
        for scope, key in (("primary_process", "npm"), ("signature", "npm test"), ("kill_reason", "idle")):
            row = self.one("SELECT killed_idle FROM counters WHERE scope=? AND key=?", (scope, key))
            self.assertEqual(row, (0,), scope)
        r = self.one("SELECT killed_idle FROM counters WHERE scope='rule' AND key='global'")
        self.assertEqual(r, (1,))

    def rule_counters(self, columns):
        return self.one("SELECT {} FROM counters WHERE scope='rule' AND key='global'".format(columns))

    def test_untargeted_success_counts_untargeted_columns(self):
        ss.record_run(self.path, rec(loop="untargeted", exec_time=12.0))
        ss.record_run(self.path, rec(loop="untargeted", exec_time=30.0))
        ss.record_run(self.path, rec(loop="none", exec_time=99.0))  # not a polling loop: not counted
        self.assertEqual(self.rule_counters("untargeted_successful, untargeted_execution_max, successful"),
                         (2, 30.0, 3))

    def test_max_runtime_kill_counts_killed_max_runtime(self):
        ss.record_run(self.path, rec(outcome="killed", kill="max-runtime", fired="max_runtime"))
        self.assertEqual(self.rule_counters("killed, killed_max_runtime, killed_idle, killed_poll_cap"),
                         (1, 1, 0, 0))

    def test_poll_cap_kill_counts_killed_poll_cap_not_untargeted_success(self):
        ss.record_run(self.path, rec(outcome="killed", kill="max-runtime", fired="poll_cap", loop="untargeted",
                                     exec_time=1800.0))
        self.assertEqual(
            self.rule_counters("killed, killed_poll_cap, killed_max_runtime, untargeted_successful, "
                               "untargeted_execution_max"),
            (1, 1, 0, 0, 0.0))

    def test_rule_version_changes_only_on_change(self):
        ss.record_run(self.path, rec(cfg={"idle": 90}))
        ss.record_run(self.path, rec(cfg={"idle": 90}))
        ss.record_run(self.path, rec(cfg={"idle": 120}))
        self.assertEqual(self.one("SELECT COUNT(*) FROM rule_versions WHERE rule_key='global'"), (2,))
        self.assertEqual(self.one("SELECT MAX(version) FROM rule_versions WHERE rule_key='global'"), (2,))

    def test_overridden_run_creates_no_version_and_uses_override_scope(self):
        ss.record_run(self.path, rec(env=True))
        self.assertEqual(self.one("SELECT COUNT(*) FROM rule_versions"), (0,))
        self.assertEqual(self.one("SELECT invocations FROM counters WHERE scope='rule_override' AND key='global'"), (1,))
        self.assertIsNone(self.one("SELECT 1 FROM counters WHERE scope='rule' AND key='global'"))
        self.assertEqual(self.one("SELECT override_vars FROM invocations"), ("WATCHDOG_IDLE",))

    def test_output_tail_only_for_killed_runs_and_capped(self):
        tail = [("2026-10-14T10:00:0{}+00:00".format(i % 10), "x" * 5000) for i in range(25)]
        ss.record_run(self.path, rec(outcome="success", tail=tail))
        ss.record_run(self.path, rec(outcome="killed", kill="idle", fired="idle", tail=tail))
        conn = ss.connect(self.path, readonly=True)
        try:
            rows = conn.execute("SELECT invocation_id, COUNT(*), MAX(LENGTH(line)) FROM output_tail "
                                "GROUP BY invocation_id").fetchall()
        finally:
            conn.close()
        self.assertEqual(rows, [(2, 20, 4096)])

    def test_failed_write_rolls_back_everything(self):
        original = ss._bump
        calls = {"n": 0}

        def boom(conn, scope, key, version, record):
            calls["n"] += 1
            if calls["n"] == 2:
                raise sqlite3.OperationalError("disk full")
            return original(conn, scope, key, version, record)

        ss._bump = boom
        try:
            with self.assertRaises(sqlite3.OperationalError):
                ss.record_run(self.path, rec())
        finally:
            ss._bump = original
        self.assertEqual(self.one("SELECT COUNT(*) FROM invocations"), (0,))
        self.assertEqual(self.one("SELECT COUNT(*) FROM counters"), (0,))

    def test_racing_writers_create_one_version(self):
        errors = []

        def worker():
            try:
                ss.record_run(self.path, rec(cfg={"idle": 77}))
            except Exception as error:  # pragma: no cover - reported below
                errors.append(error)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(self.one("SELECT COUNT(*) FROM rule_versions WHERE rule_key='global'"), (1,))

    def test_missing_store_is_not_created(self):
        other = os.path.join(self.dir.name, "absent", "stats.db")
        with self.assertRaises(sqlite3.OperationalError):
            ss.record_run(other, rec())
        self.assertFalse(os.path.exists(other))


if __name__ == "__main__":
    unittest.main()
