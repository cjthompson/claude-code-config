import dataclasses, glob, os, sqlite3, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
import stats_store as ss
from stats_store import RunRecord


def rec(ended, signature="npm test", outcome="success"):
    return RunRecord(started_at=ended, ended_at=ended, command_line="npm test", primary_process="npm",
                     signature=signature, loop_kind="none", rule_key="global", ini_values={"idle": 90},
                     env_overrides=False, override_vars=(), rtk_proxied=False, outcome=outcome,
                     kill_reason=None, fired_check="none", exit_code=0, execution_time=1.0, cpu_time=0.5,
                     max_silence=0.2, no_output_time=0.1)


class PruneTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "stats.db")
        ss.enable(self.path)

    def count(self, sql):
        conn = ss.connect(self.path, readonly=True)
        try:
            return conn.execute(sql).fetchone()[0]
        finally:
            conn.close()

    def test_prune_removes_old_detail_keeps_counters_and_is_gated(self):
        ss.record_run(self.path, rec("2026-08-01T00:00:00+00:00"), now="2026-08-01T00:00:00+00:00")
        ss.record_run(self.path, rec("2026-10-13T00:00:00+00:00"), now="2026-10-14T00:00:00+00:00")
        self.assertEqual(self.count("SELECT COUNT(*) FROM invocations"), 1)
        self.assertEqual(self.count("SELECT invocations FROM counters WHERE scope='global'"), 2)
        conn = ss.connect(self.path)
        try:
            self.assertFalse(ss.maybe_prune(conn, "2026-10-14T06:00:00+00:00"))
        finally:
            conn.close()

    def test_rtk_hook_never_prunes(self):
        ss.record_run(self.path, rec("2026-08-01T00:00:00+00:00"), now="2026-08-01T00:00:00+00:00")
        ss.record_run(self.path, rec("2026-10-13T00:00:00+00:00", signature="rtk hook"),
                      now="2026-10-14T00:00:00+00:00")
        self.assertEqual(self.count("SELECT COUNT(*) FROM invocations WHERE signature='npm test'"), 1)

    def test_reset_backs_up_then_clears_and_keeps_file(self):
        ss.record_run(self.path, rec("2026-10-13T00:00:00+00:00"))
        backup = ss.reset(self.path, now="2026-10-14T09:08:07+00:00")
        self.assertTrue(os.path.basename(backup).startswith("stats-backup-"))
        self.assertTrue(os.path.exists(self.path))
        self.assertEqual(self.count("SELECT COUNT(*) FROM invocations"), 0)
        self.assertEqual(self.count("SELECT COUNT(*) FROM counters"), 0)
        backup_conn = sqlite3.connect(backup)
        try:
            self.assertEqual(backup_conn.execute("SELECT COUNT(*) FROM invocations").fetchone()[0], 1)
        finally:
            backup_conn.close()

    def test_reset_clears_rule_versions_output_tail_and_last_prune(self):
        killed = dataclasses.replace(
            rec("2026-10-13T00:00:00+00:00", outcome="killed"), kill_reason="idle", fired_check="idle",
            exit_code=None, output_tail=(("2026-10-13T00:00:00+00:00", "last line"),))
        ss.record_run(self.path, killed, now="2026-10-14T00:00:00+00:00")
        self.assertEqual(self.count("SELECT COUNT(*) FROM rule_versions"), 1)
        self.assertEqual(self.count("SELECT COUNT(*) FROM output_tail"), 1)
        self.assertNotEqual(self.count("SELECT value FROM meta WHERE key='last_prune'"), "")
        ss.reset(self.path, now="2026-10-14T09:08:07+00:00")
        self.assertEqual(self.count("SELECT COUNT(*) FROM rule_versions"), 0)
        self.assertEqual(self.count("SELECT COUNT(*) FROM output_tail"), 0)
        self.assertEqual(self.count("SELECT value FROM meta WHERE key='last_prune'"), "")

    def test_reset_twice_in_same_second_keeps_first_backup(self):
        ss.record_run(self.path, rec("2026-10-13T00:00:00+00:00"))
        first = ss.reset(self.path, now="2026-10-14T09:08:07+00:00")
        second = ss.reset(self.path, now="2026-10-14T09:08:07+00:00")
        self.assertNotEqual(first, second)
        self.assertTrue(os.path.exists(first))
        self.assertTrue(os.path.exists(second))
        self.assertTrue(second.endswith("-2.db"))
        backup_conn = sqlite3.connect(first)
        try:
            self.assertEqual(backup_conn.execute("SELECT COUNT(*) FROM invocations").fetchone()[0], 1)
        finally:
            backup_conn.close()

    def test_delete_all_removes_store_and_backups_but_not_ini(self):
        ini = os.path.join(self.dir.name, "watchdog-patterns.ini")
        with open(ini, "w") as handle:
            handle.write("[global]\n")
        ss.record_run(self.path, rec("2026-10-13T00:00:00+00:00"))
        ss.reset(self.path, now="2026-10-14T09:08:07+00:00")
        removed = ss.delete_all(self.path)
        self.assertFalse(os.path.exists(self.path))
        self.assertEqual(glob.glob(os.path.join(self.dir.name, "stats-backup-*.db")), [])
        self.assertTrue(os.path.exists(ini))
        self.assertTrue(removed)



class DeleteAllGlobTests(unittest.TestCase):
    def test_glob_characters_in_store_directory_never_reach_a_sibling(self):
        with tempfile.TemporaryDirectory() as base:
            own = os.path.join(base, "st[ab]*")
            sibling = os.path.join(base, "stab")  # what an unescaped "st[ab]*" pattern would match
            os.makedirs(own)
            os.makedirs(sibling)
            path = os.path.join(own, "stats.db")
            ss.enable(path)
            own_backup = os.path.join(own, "stats-backup-20260101-000000.db")
            sibling_backup = os.path.join(sibling, "stats-backup-20260101-000000.db")
            for name in (own_backup, sibling_backup):
                with open(name, "w") as handle:
                    handle.write("x")
            removed = ss.delete_all(path)
            self.assertIn(own_backup, removed)
            self.assertFalse(os.path.exists(own_backup))
            self.assertFalse(os.path.exists(path))
            self.assertTrue(os.path.exists(sibling_backup))
            self.assertNotIn(sibling_backup, removed)


if __name__ == "__main__":
    unittest.main()
