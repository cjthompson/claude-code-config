import os, sqlite3, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks"))
import stats_store as ss
import output_tail


class TailLimitTests(unittest.TestCase):
    def test_stored_tail_reuses_the_live_tail_limits(self):
        self.assertIs(ss.LINE_LIMIT, output_tail.LINE_LIMIT,
                      msg="stats_store must import the line limit, not keep a second copy")
        self.assertIs(ss.TAIL_LIMIT, output_tail.TAIL_LIMIT,
                      msg="stats_store must import the tail limit, not keep a second copy")


class ImportPlacementTests(unittest.TestCase):
    def test_imports_come_before_any_other_module_code(self):
        import ast
        with open(os.path.join(os.path.dirname(ss.__file__), "stats_store.py"), encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        seen_code = False
        for index, node in enumerate(tree.body):
            is_docstring = (index == 0 and isinstance(node, ast.Expr)
                            and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str))
            if is_docstring:
                continue
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                self.assertFalse(seen_code, msg="import at line {} follows module code".format(node.lineno))
            else:
                seen_code = True


class BackupPathTests(unittest.TestCase):
    def test_claims_the_next_free_name_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            stem = os.path.join(directory, "stats-backup-20261028-120000")
            first = ss.claim_backup_path(stem, ".db")
            with open(first, "w") as handle:
                handle.write("kept")
            second = ss.claim_backup_path(stem, ".db")
            self.assertEqual(first, stem + ".db")
            self.assertEqual(second, stem + "-2.db")
            with open(first) as handle:
                self.assertEqual(handle.read(), "kept")


class PathTests(unittest.TestCase):
    def test_env_override_wins(self):
        self.assertEqual(ss.store_dir({"COMMAND_WATCHDOG_HOME": "/x"}, "darwin"), "/x")

    def test_platform_defaults(self):
        self.assertEqual(ss.store_dir({"HOME": "/h"}, "darwin"), "/h/Library/Application Support/command-watchdog")
        self.assertEqual(ss.store_dir({"HOME": "/h"}, "linux"), "/h/.local/share/command-watchdog")
        self.assertEqual(ss.store_dir({"XDG_DATA_HOME": "/d"}, "linux"), "/d/command-watchdog")
        self.assertEqual(ss.store_dir({"LOCALAPPDATA": "C:\\L"}, "win32"), "C:\\L\\command-watchdog")


class EnableTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "nested", "stats.db")

    def test_gate_no_file_no_create(self):
        self.assertFalse(ss.is_enabled(self.path))
        with self.assertRaises(sqlite3.OperationalError):
            ss.connect(self.path)
        self.assertFalse(os.path.exists(self.path))
        self.assertFalse(os.path.exists(os.path.dirname(self.path)))

    def test_enable_creates_schema_wal_and_is_idempotent(self):
        ss.enable(self.path)
        self.assertTrue(ss.is_enabled(self.path))
        self.assertEqual(ss.check_schema(self.path), "ok")
        conn = ss.connect(self.path)
        try:
            self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(conn.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertTrue({"meta", "rule_versions", "invocations", "output_tail", "counters"} <= tables)
            self.assertEqual(conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0], "1")
        finally:
            conn.close()
        ss.enable(self.path)  # idempotent, no error

    def test_corrupt_and_unknown_version_are_reported_not_overwritten(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "wb") as handle:
            handle.write(b"not a database")
        self.assertEqual(ss.check_schema(self.path), "corrupt")
        with self.assertRaises(ss.StoreError):
            ss.enable(self.path)
        with open(self.path, "rb") as handle:
            self.assertEqual(handle.read(), b"not a database")

    def test_readonly_connection_cannot_write(self):
        ss.enable(self.path)
        conn = ss.connect(self.path, readonly=True)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                conn.execute("INSERT INTO meta(key, value) VALUES ('x', 'y')")
        finally:
            conn.close()


class CheckConstraintTests(unittest.TestCase):
    """The fired_check CHECK uses IS NOT NULL, because SQLite passes a CHECK that evaluates to NULL."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, "stats.db")
        ss.enable(self.path)
        self.conn = ss.connect(self.path)
        self.addCleanup(self.conn.close)

    def insert(self, outcome, kill_reason, fired_check, loop_kind="none"):
        self.conn.execute(
            "INSERT INTO invocations (started_at, ended_at, command_line, primary_process, signature, loop_kind, "
            "rule_key, rule_version, env_overrides, override_vars, rtk_proxied, outcome, kill_reason, fired_check, "
            "exit_code, execution_time, cpu_time, max_silence, no_output_time) "
            "VALUES ('t','t','c','p','s',?, 'global', 0, 0, '', 0, ?, ?, ?, 0, 1.0, 0.0, 0.0, 0.0)",
            (loop_kind, outcome, kill_reason, fired_check))

    def test_idle_or_max_runtime_with_null_kill_reason_is_rejected(self):
        # outcome 'success' with a NULL kill_reason satisfies the outcome CHECK, so only the
        # fired_check CHECK can reject these rows.
        for fired in ("idle", "max_runtime"):
            with self.subTest(fired_check=fired):
                with self.assertRaises(sqlite3.IntegrityError):
                    self.insert("success", None, fired)

    def test_poll_cap_requires_an_untargeted_loop(self):
        for loop in ("none", "targeted"):
            with self.subTest(loop_kind=loop):
                with self.assertRaises(sqlite3.IntegrityError):
                    self.insert("killed", "max-runtime", "poll_cap", loop)
        self.insert("killed", "max-runtime", "poll_cap", "untargeted")  # the valid combination is accepted
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM invocations").fetchone()[0], 1)


class UriEscapingTests(unittest.TestCase):
    def test_special_characters_in_path(self):
        with tempfile.TemporaryDirectory() as base:
            directory = os.path.join(base, "a#b%20c?d")
            path = os.path.join(directory, "stats.db")
            ss.enable(path)
            self.assertEqual(os.listdir(directory), ["stats.db"])
            for readonly in (True, False):
                conn = ss.connect(path, readonly=readonly)
                try:
                    row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
                    self.assertEqual(row[0], "1")
                finally:
                    conn.close()
            self.assertEqual(ss.check_schema(path), "ok")
            self.assertFalse(os.path.exists(os.path.join(base, "a")))
            self.assertTrue(set(os.listdir(directory)) <= {"stats.db", "stats.db-wal", "stats.db-shm"})
            self.assertEqual(os.listdir(base), ["a#b%20c?d"])


if __name__ == "__main__":
    unittest.main()
