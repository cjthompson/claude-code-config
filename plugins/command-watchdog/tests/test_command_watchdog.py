"""Behavior tests for command-watchdog.py poll mode.

Run: /usr/bin/python3 -m unittest discover -s plugins/command-watchdog/tests -v
"""
import importlib.util
import os
import signal
import subprocess
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

HERE = os.path.dirname(os.path.abspath(__file__))
WATCHDOG = os.path.join(HERE, "..", "hooks", "command-watchdog.py")

spec = importlib.util.spec_from_file_location("command_watchdog", WATCHDOG)
assert spec is not None and spec.loader is not None
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)

BUSY = "import time,sys; t=time.time()\nwhile time.time()-t<{secs}: pass"


def run(cmd, **env):
    full_env = dict(os.environ, WATCHDOG_POLL="1", WATCHDOG_IDLE="4")
    full_env.update({k: str(v) for k, v in env.items()})
    start = time.time()
    r = subprocess.run(
        ["/usr/bin/python3", WATCHDOG, cmd],
        capture_output=True, text=True, env=full_env, timeout=60,
    )
    return r.returncode, r.stdout, time.time() - start


def killpg(p):
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass  # group already gone (macOS reports EPERM for an exited group)


def marker():
    return "cw-test-" + uuid.uuid4().hex[:8]


class ParseTests(unittest.TestCase):
    def test_detects_wait_loops(self):
        self.assertTrue(cw.is_poll_loop("until ! pgrep -f x; do sleep 5; done"))
        self.assertFalse(cw.is_poll_loop("until false; do echo; sleep 1; done"))
        self.assertFalse(cw.is_poll_loop("while true; do echo; sleep 1; done"))
        self.assertFalse(cw.is_poll_loop('while read -r u; do curl -s "$u"; sleep 1; done < ./urls.txt'))
        self.assertFalse(cw.is_poll_loop("while true; do pgrep -f server && break; sleep 2; done"))
        self.assertFalse(cw.is_poll_loop('while [ -z "$(pgrep -f server)" ]; do sleep 1; done'))
        self.assertFalse(cw.is_poll_loop("while pgrep -f server && false; do sleep 1; done"))
        self.assertFalse(cw.is_poll_loop("bin/rspec spec/foo_spec.rb"))

    def test_parses_incident_pgrep(self):
        cmd = ("cd /tmp && until ! pgrep -f 'DISABLE_SPRING=1 bin/tapioca dsl --verify' "
               "> /dev/null 2>&1; do sleep 30; done")
        (t,) = cw.parse_pgrep_targets(cmd)
        self.assertTrue(t.negated)
        self.assertTrue(t.full)
        self.assertEqual(t.source, "DISABLE_SPRING=1 bin/tapioca dsl --verify")

    def test_parses_unnegated_name_pgrep(self):
        (t,) = cw.parse_pgrep_targets('until pgrep ruby >/dev/null; do sleep 1; done')
        self.assertFalse(t.negated)
        self.assertFalse(t.full)

    def test_paths_skip_dirs_devices_and_executables(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "x.log")
            cmd = "cd {d} && until grep -q DONE {log} 2>/dev/null; do /usr/bin/true; sleep 1; done".format(d=d, log=log)
            self.assertEqual(cw.parse_path_targets(cmd), [os.path.abspath(log)])


    def test_relative_paths_follow_cd(self):
        with tempfile.TemporaryDirectory() as d:
            sub = os.path.join(d, "job")
            os.mkdir(sub)
            cmd = "cd {} && until grep -q DONE ./run.log; do sleep 1; done".format(sub)
            self.assertEqual(cw.parse_path_targets(cmd), [os.path.join(sub, "run.log")])

    def test_unresolvable_cd_drops_relative_paths(self):
        self.assertEqual(cw.parse_path_targets('cd "$DIR" && until grep -q DONE ./run.log; do sleep 1; done'), [])

    def test_shell_expanded_pgrep_patterns_are_skipped(self):
        self.assertEqual(cw.parse_pgrep_targets('pat=x; until ! pgrep -f "$pat"; do sleep 1; done'), [])
        self.assertEqual(cw.parse_pgrep_targets("until ! pgrep -f $pat; do sleep 1; done"), [])
        self.assertEqual(cw.parse_pgrep_targets("until ! pgrep -P $$ sleep; do sleep 1; done"), [])
        self.assertEqual(cw.parse_pgrep_targets("until ! pgrep -f foo$$; do sleep 1; done"), [])
        (t,) = cw.parse_pgrep_targets("until ! pgrep -f 'rspec$'; do sleep 1; done")
        self.assertEqual(t.source, "rspec$")

    def test_loop_output_files_are_not_targets(self):
        self.assertEqual(cw.parse_path_targets("until ! pgrep -f foo; do echo . >> /tmp/wait.log; sleep 1; done"), [])
        self.assertEqual(cw.parse_path_targets("until ! pgrep -f foo; do date | tee -a /tmp/wait.log; sleep 1; done"), [])
        self.assertEqual(cw.parse_path_targets("until grep -q DONE /tmp/r.log; do echo . 2>/tmp/e.log; sleep 1; done"),
                         ["/tmp/r.log"])

    def test_pgrep_option_forms(self):
        def one(cmd):
            (t,) = cw.parse_pgrep_targets(cmd)
            return t
        t = one("until ! pgrep -f -- 'bin/rspec'; do sleep 1; done")
        self.assertEqual((t.source, t.full), ("bin/rspec", True))
        t = one("until ! pgrep -u me -f bin/rspec >/dev/null; do sleep 1; done")
        self.assertEqual((t.source, t.full), ("bin/rspec", True))
        self.assertEqual(t.args, ("-u", "me", "-f", "bin/rspec"))
        t = one("until ! pgrep -fu me bin/rspec; do sleep 1; done")
        self.assertEqual(t.source, "bin/rspec")
        t = one("until ! pgrep -xi RSPEC; do sleep 1; done")
        self.assertEqual(t.args, ("-xi", "RSPEC"))
        t = one("until ! pgrep -qf RSPEC; do sleep 1; done")
        self.assertEqual(t.args, ("-f", "RSPEC"))
        self.assertEqual(cw.parse_pgrep_targets("until ! pgrep -f 'oops; do sleep 1; done"), [])
        self.assertEqual(cw.parse_pgrep_targets("until ! pgrep -d , -f rspec; do sleep 1; done"), [])
        self.assertEqual(cw.parse_pgrep_targets("until ! pgrep -n -f rspec; do sleep 1; done"), [])
        self.assertEqual(cw.parse_pgrep_targets("until ! pgrep -v -f rspec; do sleep 1; done"), [])
        self.assertEqual(cw.parse_pgrep_targets("until ! pgrep -s 1 -f rspec; do sleep 1; done"), [])
        self.assertEqual(cw.parse_pgrep_targets("until ! pgrep -P '$PARENT' -f rspec; do sleep 1; done"), [])

    def test_quoted_paths_with_spaces(self):
        cmd = 'until grep -q DONE "/tmp/my log.txt"; do sleep 5; done'
        self.assertEqual(cw.parse_path_targets(cmd), ["/tmp/my log.txt"])
        cmd = "until grep -q DONE '/tmp/Application Support/x.log'; do sleep 5; done"
        self.assertEqual(cw.parse_path_targets(cmd), ["/tmp/Application Support/x.log"])

    def test_grace_covers_loop_sleep(self):
        tr = cw.PollTracker("until ! pgrep -f x; do sleep 30; done", 0, 0)
        self.assertGreaterEqual(tr.grace, 30)
        tr = cw.PollTracker("until ! pgrep -f x; do sleep 1m; done", 0, 0)
        self.assertGreaterEqual(tr.grace, 60)

    def test_wait_for_exit_depends_on_while_or_until_condition(self):
        cases = (
            ("until ! pgrep -f job; do sleep 1; done", True),
            ("while pgrep -f job; do sleep 1; done", True),
            ("until pgrep -f job; do sleep 1; done", False),
            ("while ! pgrep -f job; do sleep 1; done", False),
            ("until ! /usr/bin/pgrep -f job; do sleep 1; done", True),
            ("while ! /usr/bin/pgrep -f job; do sleep 1; done", False),
        )
        for command, expected in cases:
            with self.subTest(command=command):
                (target,) = cw.parse_pgrep_targets(command)
                self.assertEqual(target.wait_for_exit, expected)

    def test_pgrep_outside_direct_condition_is_not_a_target(self):
        self.assertEqual(cw.parse_pgrep_targets("while true; do pgrep -f server && break; sleep 2; done"), [])
        self.assertEqual(cw.parse_pgrep_targets('while [ -z "$(pgrep -f server)" ]; do sleep 1; done'), [])
        self.assertEqual(cw.parse_pgrep_targets("while pgrep -f server && false; do sleep 1; done"), [])

    def test_waiter_vs_wrapper_shells(self):
        mk = lambda c: cw.Proc(1, 1, 1, 0.0, 0.0, c)
        self.assertTrue(cw.is_waiter(mk("/bin/bash -c until ! pgrep -f x; do sleep 1; done")))
        self.assertTrue(cw.is_waiter(mk("/bin/bash -c while true; do sleep 1; done")))
        self.assertFalse(cw.is_waiter(mk("/bin/bash -c while read -r u; do curl $u; sleep 1; done")))
        self.assertFalse(cw.is_waiter(mk("/bin/bash -lc bin/tapioca dsl --verify")))
        self.assertTrue(cw.is_waiter(mk("-zsh")))
        self.assertEqual(cw.shell_kind(mk("/bin/bash -o pipefail -c 'echo ok'")), "inline")

    def test_pgrep_parent_filter_excludes_unrelated_matching_process(self):
        m = marker()
        target = subprocess.Popen(["/usr/bin/python3", "-c", "import time; time.sleep(30)", m])
        try:
            (selector,) = cw.parse_pgrep_targets(
                "until pgrep -P 1 -f '{}'; do sleep 1; done".format(m)
            )
            matches = cw.pgrep_matches(selector, cw.snapshot(), -1, set())
            self.assertEqual(matches, [])
        finally:
            target.kill()
            target.wait()

    def test_tail_process_is_not_discarded_as_a_loop_helper(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, marker() + ".log")
            open(path, "w").close()
            target = subprocess.Popen(["/usr/bin/tail", "-f", path],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                (selector,) = cw.parse_pgrep_targets(
                    "until ! pgrep -f '{}'; do sleep 1; done".format(path)
                )
                matches = cw.pgrep_matches(selector, cw.snapshot(), -1, set())
                self.assertIn(target.pid, [p.pid for p in matches])
            finally:
                target.kill()
                target.wait()

    def test_new_worker_with_cpu_counts_as_progress(self):
        tracker = cw.PollTracker("until ! pgrep -f worker; do sleep 1; done", 0, 0)
        tracker.prev_cpu = {10: 0.0}
        self.assertTrue(tracker._advanced({10: 0.0, 11: 0.2}, [10, 11]))

    def test_pgrep_pid_missing_from_snapshot_is_unknown(self):
        (selector,) = cw.parse_pgrep_targets("until ! pgrep -f worker; do sleep 1; done")
        result = subprocess.CompletedProcess(["/usr/bin/pgrep"], 0, "12345\n", "")
        with patch.object(cw.subprocess, "run", return_value=result):
            self.assertIsNone(cw.pgrep_matches(selector, [], -1, set()))

    def test_failed_pgrep_query_does_not_count_as_activity(self):
        tracker = cw.PollTracker("until pgrep -f worker; do sleep 1; done", 0, 0)
        with patch.object(cw, "snapshot", return_value=[]), patch.object(cw, "pgrep_matches", return_value=None):
            self.assertEqual(tracker.sample(10), (False, False))

    def test_while_pgrep_wait_for_exit_uses_target_gone_grace(self):
        tracker = cw.PollTracker("while pgrep -f worker; do sleep 1; done", 0, 0)
        with patch.object(cw, "snapshot", return_value=[]), patch.object(cw, "pgrep_matches", return_value=[]):
            self.assertEqual(tracker.sample(10), (False, False))
            self.assertEqual(tracker.sample(10 + tracker.grace), (False, True))

    def test_terminal_shell_does_not_make_a_real_target_a_checker(self):
        terminal = cw.Proc(1, 0, 1, 100, 0, "-zsh")
        tail = cw.Proc(2, 1, 2, 10, 0, "/usr/bin/tail -f /tmp/work.log")
        self.assertFalse(cw.checker_descendant(tail, {1: terminal, 2: tail}))
        waiter = cw.Proc(3, 1, 3, 10, 0, "/bin/bash -c while ! pgrep -f work; do sleep 1; done")
        checker = cw.Proc(4, 3, 3, 1, 0, "/usr/bin/pgrep -f work")
        self.assertTrue(cw.checker_descendant(checker, {1: terminal, 3: waiter, 4: checker}))

class PollModeTests(unittest.TestCase):
    def test_throttled_work_loop_keeps_output_activity(self):
        with tempfile.TemporaryDirectory() as d:
            source = os.path.join(d, "urls.txt")
            with open(source, "w") as f:
                f.write("a\nb\nc\nd\ne\nf\n")
            code, out, _ = run(
                "while read -r u; do echo $u; sleep 1; done < {}".format(source),
                WATCHDOG_IDLE=4,
            )
        self.assertEqual(code, 0, out)
        self.assertIn("f", out)

    def test_while_not_pgrep_waits_for_start_without_target_gone(self):
        code, out, _ = run("while ! pgrep -x cw-no-such-process >/dev/null; do sleep 1; done",
                           WATCHDOG_IDLE=8)
        self.assertEqual(code, 124)
        self.assertIn("poll-idle", out)
        self.assertNotIn("target-gone", out)

    def test_absolute_pgrep_waits_for_start_without_target_gone(self):
        code, out, _ = run("while ! /usr/bin/pgrep -x cw-no-such-process >/dev/null; do sleep 1; done",
                           WATCHDOG_IDLE=8)
        self.assertEqual(code, 124)
        self.assertIn("poll-idle", out)
        self.assertNotIn("target-gone", out)

    def test_pgrep_query_errors_end_as_poll_idle(self):
        code, out, secs = run("until pgrep -u cw_missing_user_20260925 job; do sleep 1; done")
        self.assertEqual(code, 124)
        self.assertIn("poll-idle", out)
        self.assertLess(secs, 30)

    def test_loop_matching_only_other_shells_is_killed_fast(self):
        m = marker()
        # Stands in for another wait loop whose shell argv contains the pattern.
        other = subprocess.Popen(["/bin/sh", "-c", "while true; do sleep 1; done; : " + m], start_new_session=True)
        try:
            # Idle window well above the grace period, so target-gone must win.
            code, out, secs = run("until ! pgrep -f '{}' >/dev/null; do sleep 1; echo -n .; done".format(m), WATCHDOG_IDLE=10)
        finally:
            killpg(other)
            other.wait()
        self.assertEqual(code, 124)
        self.assertIn("target-gone", out)
        self.assertLess(secs, 30)

    def test_busy_external_target_keeps_loop_alive(self):
        m = marker()
        target = subprocess.Popen(["/usr/bin/python3", "-c", BUSY.format(secs=7), m])
        try:
            code, out, _ = run("until ! pgrep -f '{}' >/dev/null; do sleep 1; echo -n .; done; echo finished".format(m))
        finally:
            target.kill()
            target.wait()
        self.assertEqual(code, 0, out)
        self.assertIn("finished", out)

    def test_idle_external_target_is_killed(self):
        m = marker()
        target = subprocess.Popen(["/usr/bin/python3", "-c", "import time; time.sleep(60)", m])
        try:
            code, out, secs = run("until ! pgrep -f '{}' >/dev/null; do sleep 1; echo -n .; done".format(m))
        finally:
            target.kill()
            target.wait()
        self.assertEqual(code, 124)
        self.assertIn("poll-idle", out)
        self.assertLess(secs, 30)

    def test_growing_log_keeps_loop_alive_until_done(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "run.log")
            open(log, "w").close()
            writer = subprocess.Popen([
                "/usr/bin/python3", "-c",
                "import time,sys\nfor i in range(7):\n  open(sys.argv[1],'a').write('.\\n'); time.sleep(1)\n"
                "open(sys.argv[1],'a').write('DONE\\n')", log,
            ])
            try:
                code, out, _ = run("until grep -q DONE {}; do sleep 1; echo -n .; done; echo finished".format(log))
            finally:
                writer.kill()
                writer.wait()
        self.assertEqual(code, 0, out)
        self.assertIn("finished", out)

    def test_stalled_log_is_killed(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "run.log")
            with open(log, "w") as f:
                f.write("started\n")
            code, out, secs = run("until grep -q DONE {}; do sleep 1; echo -n .; done".format(log))
        self.assertEqual(code, 124)
        self.assertIn("poll-idle", out)
        self.assertLess(secs, 30)

    def test_in_group_work_keeps_loop_alive(self):
        with tempfile.TemporaryDirectory() as d:
            flag = os.path.join(d, "flag")
            cmd = ("until [ -s {flag} ]; do /usr/bin/python3 -c '{busy}'; echo x > {flag}; sleep 1; done; "
                   "echo finished").format(flag=flag, busy=BUSY.format(secs=8))
            code, out, _ = run(cmd)
        self.assertEqual(code, 0, out)
        self.assertIn("finished", out)

    def test_busy_external_shell_script_keeps_loop_alive(self):
        m = marker()
        with tempfile.TemporaryDirectory() as d:
            script = os.path.join(d, m + ".sh")
            with open(script, "w") as f:
                f.write("end=$((SECONDS+8)); while [ $SECONDS -lt $end ]; do :; done\n")
            target = subprocess.Popen(["/bin/bash", script], start_new_session=True)
            try:
                code, out, _ = run("until ! pgrep -f '{}' >/dev/null; do sleep 1; echo -n .; done; echo finished".format(m))
            finally:
                killpg(target)
                target.wait()
        self.assertEqual(code, 0, out)
        self.assertIn("finished", out)

    def test_in_group_shell_script_counts_as_work(self):
        with tempfile.TemporaryDirectory() as d:
            script = os.path.join(d, "busy.sh")
            flag = os.path.join(d, "flag")
            with open(script, "w") as f:
                f.write("end=$((SECONDS+8)); while [ $SECONDS -lt $end ]; do :; done\n")
            code, out, _ = run("until [ -s {flag} ]; do bash {script}; echo x > {flag}; sleep 1; done; echo finished".format(flag=flag, script=script))
        self.assertEqual(code, 0, out)
        self.assertIn("finished", out)

    def test_heredoc_loop_text_is_not_a_loop(self):
        self.assertFalse(cw.is_poll_loop("python3 - <<'EOF'\nx = 'until ! pgrep -f a; do sleep 1; done'\nEOF"))

    def test_inline_vs_script_shells(self):
        mk = lambda c: cw.Proc(1, 1, 1, 0.0, 0.0, c)
        self.assertTrue(cw.is_noise(mk("/bin/zsh -c source snap && eval 'x'")))
        self.assertTrue(cw.is_noise(mk("-zsh")))
        self.assertTrue(cw.is_noise(mk("/bin/bash -lc 'until x'")))
        self.assertFalse(cw.is_noise(mk("/bin/bash /tmp/fresheyes.sh --x")))
        self.assertFalse(cw.is_noise(mk("bash -e ./run.sh")))

    def test_loop_writing_its_own_log_is_still_killed(self):
        m = marker()
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "wait.log")
            other = subprocess.Popen(["/bin/sh", "-c", "while true; do sleep 1; done; : " + m], start_new_session=True)
            try:
                code, out, _ = run("until ! pgrep -f '{}' >/dev/null; do echo . >> {}; sleep 1; done".format(m, log),
                                   WATCHDOG_IDLE=10)
            finally:
                killpg(other)
                other.wait()
        self.assertEqual(code, 124)
        self.assertIn("target-gone", out)

    def test_target_exiting_mid_sleep_is_not_a_false_kill(self):
        m = marker()
        target = subprocess.Popen(["/usr/bin/python3", "-c", "import time; time.sleep(1.5)", m])
        try:
            code, out, _ = run("until ! pgrep -f '{}' >/dev/null; do sleep 6; done; echo finished".format(m),
                               WATCHDOG_IDLE=30)
        finally:
            target.kill()
            target.wait()
        self.assertEqual(code, 0, out)
        self.assertIn("finished", out)

    def test_inline_shell_wrapper_target_keeps_loop_alive(self):
        m = marker()
        wrapper = subprocess.Popen(
            ["/bin/sh", "-c", "/usr/bin/python3 -c '{}'; : {}".format(BUSY.format(secs=7), m)],
            start_new_session=True,
        )
        try:
            code, out, _ = run("until ! pgrep -f '{}' >/dev/null; do sleep 1; echo -n .; done; echo finished".format(m))
        finally:
            killpg(wrapper)
            wrapper.wait()
        self.assertEqual(code, 0, out)
        self.assertIn("finished", out)

    def test_untargeted_loop_hits_poll_cap(self):
        code, out, secs = run('until [ -s "$flag" ]; do sleep 1; echo .; done', WATCHDOG_POLL_CAP=5)
        self.assertEqual(code, 124)
        self.assertIn("max-runtime", out)
        self.assertLess(secs, 30)

    def test_plain_command_unchanged(self):
        code, out, _ = run("echo hi; exit 3")
        self.assertEqual(code, 3)
        self.assertIn("hi", out)


if __name__ == "__main__":
    unittest.main()
