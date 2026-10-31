"""Exercise the shared hook's wire protocol and command lifecycle."""
import json
import fcntl
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import termios
import time
import unittest

PLUGIN = Path(__file__).resolve().parents[1]
LOWEST_NICE = 20 if sys.platform == "darwin" else 19


class HookTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "plugin with spaces"
        shutil.copytree(PLUGIN / "hooks", self.root / "hooks")
        self.env = dict(os.environ, PATH="/usr/bin:/bin", CLAUDE_PLUGIN_ROOT=str(self.root),
                        WATCHDOG_POLL="1",
                        COMMAND_WATCHDOG_HOME=str(Path(self.temporary.name) / "store"))
        for name in ("WATCHDOG_IDLE", "WATCHDOG_MAX_RUNTIME"):
            self.env.pop(name, None)

    def hook_result(self, command, host="codex"):
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
                   "tool_input": {"command": command}, "cwd": self.temporary.name,
                   "session_id": "hook-test", "tool_use_id": "call-test"}
        env = dict(self.env)
        if host == "codex":
            payload["turn_id"] = "turn-test"
            env["PLUGIN_ROOT"] = str(self.root)
        config = json.loads((self.root / "hooks/hooks.json").read_text())
        hook_command = config["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        return subprocess.run(["/bin/sh", "-c", hook_command], input=json.dumps(payload),
                              text=True, capture_output=True, env=env, timeout=20)

    def rewrite(self, command, host="codex", final=None):
        result = self.hook_result(command, host)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PreToolUse")
        self.assertEqual(output["permissionDecision"], "allow")
        wrapped = output["updatedInput"]["command"]
        self.assertEqual(shlex.split(wrapped)[-1], command if final is None else final)
        return wrapped

    def run_wrapped(self, command, host="codex", stdin=""):
        return subprocess.run(["/bin/bash", "-c", self.rewrite(command, host)],
                              input=stdin, text=True, capture_output=True, env=self.env,
                              cwd=self.temporary.name, timeout=20)

    def test_both_hosts_preserve_quoting_environment_stdin_and_exit_status(self):
        self.env["HOOK_TEST_VALUE"] = "inherited value"
        command = ("read -r line; printf '%s|%s\\n' \"$HOOK_TEST_VALUE\" \"$line\"; "
                   "printf '%s\\n' " + shlex.quote("quoted ' string") + " >&2; exit 7")
        for host in ("claude", "codex"):
            with self.subTest(host=host):
                result = self.run_wrapped(command, host, stdin="input with spaces\n")
                self.assertEqual(result.returncode, 7, result.stderr)
                self.assertIn("inherited value|input with spaces", result.stdout)
                self.assertIn("quoted ' string", result.stdout)

    def test_codex_task_and_descendants_have_lowest_priority(self):
        probe = "/usr/bin/python3 -c 'import os; print(os.getpriority(os.PRIO_PROCESS, 0))'"
        result = self.run_wrapped(probe + "; /bin/sh -c " + shlex.quote(probe))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([int(value) for value in result.stdout.split()], [LOWEST_NICE] * 2)

    def test_codex_output_streams_before_completion(self):
        command = "printf 'ready\\n'; sleep 2; printf 'done\\n'"
        process = subprocess.Popen(["/bin/bash", "-c", self.rewrite(command)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        try:
            self.assertTrue(select.select([process.stdout], [], [], 10)[0], "no live output")
            self.assertEqual(process.stdout.readline(), b"ready\n")
            self.assertIsNone(process.poll(), "output arrived only after completion")
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(stdout, b"done\n")
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)

    def test_codex_hard_timeout_stops_a_task(self):
        self.env["WATCHDOG_MAX_RUNTIME"] = "2"
        result = self.run_wrapped("sleep 30")
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertIn("max-runtime", result.stdout)

    def test_wrapper_does_not_inject_watchdog_idle(self):
        out = self.rewrite("npm test")
        self.assertNotIn("WATCHDOG_IDLE=", out)
        self.assertEqual(shlex.split(out)[2:5], ["--original", "npm test", "--"])

    def test_lifted_override_becomes_set_argument(self):
        out = self.rewrite("WATCHDOG_IDLE=600 npm test", final="npm test")
        parts = shlex.split(out)
        self.assertEqual(parts[2:9], ["--original", "npm test", "--set", "idle=600", "--", "npm test"])
        self.assertNotIn("WATCHDOG_IDLE=600", out)

    def test_rtk_decision_call_writes_no_stats_row_while_the_command_does(self):
        import sqlite3
        sys.path.insert(0, str(PLUGIN / "hooks"))
        import stats_store
        bin_dir = Path(self.temporary.name) / "fake-bin"
        bin_dir.mkdir()
        fake_rtk = bin_dir / "rtk"
        fake_rtk.write_text("#!/bin/sh\ncat > /dev/null\n"
                            "echo '{\"hookSpecificOutput\": {\"permissionDecision\": \"allow\", "
                            "\"updatedInput\": {\"command\": \"echo rewritten\"}}}'\n")
        fake_rtk.chmod(0o755)
        self.env["PATH"] = "{}:/usr/bin:/bin".format(bin_dir)
        db = os.path.join(self.env["COMMAND_WATCHDOG_HOME"], "stats.db")
        stats_store.enable(db)
        wrapped = self.rewrite("echo original", final="echo rewritten")
        result = subprocess.run(["/bin/bash", "-c", wrapped], capture_output=True, text=True,
                                env=self.env, cwd=self.temporary.name, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        conn = sqlite3.connect(db)
        try:
            rows = conn.execute("SELECT primary_process, rtk_proxied FROM invocations ORDER BY id").fetchall()
        finally:
            conn.close()
        self.assertEqual(rows, [("echo", 1)])

    def test_assignment_only_passes_through_unmodified(self):
        result = self.hook_result("WATCHDOG_IDLE=600")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "")  # no updatedInput: nothing wrapped
        self.assertFalse((Path(self.env["COMMAND_WATCHDOG_HOME"]) / "stats.db").exists())

    def assert_wrapped_verbatim(self, command, set_args=()):
        parts = shlex.split(self.rewrite(command))
        self.assertEqual(parts[-1], command)  # byte-for-byte, newlines included
        self.assertEqual(parts[2:4], ["--original", command])
        self.assertEqual([p for p in parts if p == "--set"], ["--set"] * len(set_args))
        return parts

    def test_command_with_newline_is_preserved_byte_for_byte(self):
        command = 'FOO=1\nprintf "[%s]\\n" "$FOO"'
        self.assertIn("\n", command)
        self.assert_wrapped_verbatim(command)
        result = self.run_wrapped(command)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_double_space_in_quoted_value_is_preserved(self):
        command = "FOO=\"a  b\" sh -c 'printf \"%s\" \"$FOO\"'"
        self.assert_wrapped_verbatim(command)
        self.assertEqual(self.run_wrapped(command).stdout, "a  b")

    def test_leading_non_lifted_assignment_is_preserved(self):
        self.assert_wrapped_verbatim("FOO=1 npm test")
        self.assert_wrapped_verbatim("  FOO=1   npm  test")

    def test_override_before_operator_is_not_lifted_and_command_is_unchanged(self):
        # Cutting the assignment out would leave `&& echo hi`, a syntax error.
        # The user's bytes are kept and the command is still supervised, with no --set.
        command = "WATCHDOG_IDLE=600 && echo hi"
        parts = self.assert_wrapped_verbatim(command)
        self.assertNotIn("--set", parts)
        result = self.run_wrapped(command)
        self.assertEqual((result.returncode, result.stdout), (0, "hi\n"), result.stderr)

    def test_rejected_override_stays_in_the_command(self):
        parts = self.assert_wrapped_verbatim("WATCHDOG_IDLE=abc npm test")
        self.assertNotIn("--set", parts)

    def test_rejected_override_with_quote_or_substitution_hides_later_tokens(self):
        for command in ('WATCHDOG_IDLE="a WATCHDOG_MAX_RUNTIME=5 b" npm test',
                        "WATCHDOG_IDLE=$(echo WATCHDOG_MAX_RUNTIME=5 ) npm test"):
            with self.subTest(command=command):
                parts = self.assert_wrapped_verbatim(command)
                self.assertNotIn("--set", parts)

    def test_lift_keeps_the_rest_of_the_command_byte_for_byte(self):
        command = 'WATCHDOG_IDLE=600 FOO="a  b" sh -c \'printf "%s" "$FOO"\''
        remaining = 'FOO="a  b" sh -c \'printf "%s" "$FOO"\''
        wrapped = self.rewrite(command, final=remaining)
        parts = shlex.split(wrapped)
        self.assertEqual(parts[2:8], ["--original", remaining, "--set", "idle=600", "--", remaining])
        result = subprocess.run(["/bin/bash", "-c", wrapped], text=True, capture_output=True,
                                env=self.env, cwd=self.temporary.name, timeout=20)
        self.assertEqual(result.stdout, "a  b")

    def test_rule_file_is_ini_and_txt_is_gone(self):
        self.assertFalse((PLUGIN / "hooks/watchdog-patterns.txt").exists())
        self.assertTrue((PLUGIN / "hooks/watchdog-patterns.ini").exists())

    def test_malformed_ini_does_not_block_bash(self):
        (self.root / "hooks/watchdog-patterns.ini").write_text("[global\nidle = = \n[rule:x]\nregex: (\n")
        os.makedirs(self.env["COMMAND_WATCHDOG_HOME"])
        (Path(self.env["COMMAND_WATCHDOG_HOME"]) / "watchdog-patterns.ini").write_bytes(b"\xff\xfe[[\n")
        result = self.run_wrapped("printf 'still runs\\n'; exit 3")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("still runs", result.stdout)

    def run_pty(self, command):
        master, slave = pty.openpty()

        def controlling_terminal():
            # Popen's setsid runs before preexec_fn. Acquiring the slave as
            # our controlling terminal models a real Codex PTY session.
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            os.tcsetpgrp(0, os.getpgrp())

        process = subprocess.Popen(["/bin/bash", "-c", self.rewrite(command)],
                                   stdin=slave, stdout=slave, stderr=slave,
                                   env=self.env, start_new_session=True,
                                   preexec_fn=controlling_terminal)
        os.close(slave)
        output = bytearray()
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                if not select.select([master], [], [], 0.2)[0]:
                    continue
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break  # PTY closes with EIO on macOS/Linux.
                if not chunk:
                    break
                output.extend(chunk)
            return process.wait(timeout=5), output.decode("utf-8")
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
            os.close(master)

    def test_codex_pty_task_is_in_background_and_has_piped_output(self):
        code = ("import json, os; print(json.dumps({'tty': [os.isatty(fd) for fd in (0, 1, 2)], "
                "'background': os.getpgrp() != os.tcgetpgrp(0)}))")
        status, output = self.run_pty("/usr/bin/python3 -c " + shlex.quote(code))
        self.assertEqual(status, 0, output)
        self.assertEqual(json.loads(output.strip()), {"tty": [True, False, False], "background": True})

    def test_codex_pty_terminal_read_receives_sigttin(self):
        code = ("import os, signal, sys; "
                "signal.signal(signal.SIGTTIN, lambda *_: (print('SIGTTIN', flush=True), sys.exit(8))); "
                "os.read(0, 1)")
        status, output = self.run_pty("/usr/bin/python3 -u -c " + shlex.quote(code))
        self.assertEqual(status, 8, output)
        self.assertIn("SIGTTIN", output)

    def test_codex_pty_waiting_for_input_is_subject_to_idle_timeout(self):
        (self.root / "hooks/watchdog-patterns.ini").write_text("[rule:all]\nregex: .\nidle: 2\n")
        code = "import os; print('ready', flush=True); os.read(0, 1)"
        status, output = self.run_pty("/usr/bin/python3 -u -c " + shlex.quote(code))
        self.assertEqual(status, 124, output)
        self.assertIn("ready", output)
        self.assertIn("HANG DETECTED (idle)", output)

    def test_codex_cancellation_stops_task_and_descendant(self):
        code = ("import json, os, subprocess, time; "
                "child = subprocess.Popen(['/bin/sleep', '30']); "
                "print(json.dumps([os.getpid(), child.pid]), flush=True); time.sleep(30)")
        command = "/usr/bin/python3 -u -c " + shlex.quote(code)
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            with self.subTest(signal=sig):
                process = subprocess.Popen(["/bin/bash", "-c", self.rewrite(command)],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           env=self.env, start_new_session=True)
                group = None
                try:
                    self.assertTrue(select.select([process.stdout], [], [], 10)[0], "task never started")
                    task_pids = json.loads(process.stdout.readline())
                    group = os.getpgid(task_pids[0])
                    process.send_signal(sig)
                    exit_code = process.wait(timeout=10)
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline and any(self.is_running(pid) for pid in task_pids):
                        time.sleep(0.1)
                    self.assertFalse(any(self.is_running(pid) for pid in task_pids), "cancellation left a task alive")
                    self.assertEqual(exit_code, 128 + sig)
                finally:
                    for pgid in (group, process.pid):
                        if pgid is not None:
                            try:
                                os.killpg(pgid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                    process.communicate(timeout=5)

    def is_running(self, pid):
        result = subprocess.run(["/bin/ps", "-o", "stat=", "-p", str(pid)],
                                capture_output=True, text=True, timeout=3)
        return bool(result.stdout.strip()) and not result.stdout.strip().startswith("Z")

    def test_cancellation_during_launch_does_not_orphan_the_task(self):
        code = """
import importlib.util, json, os, signal, subprocess, sys
spec = importlib.util.spec_from_file_location('watchdog', sys.argv[1])
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)
original_popen = subprocess.Popen
def launch(*args, **kwargs):
    task = original_popen(*args, **kwargs)
    print(json.dumps(task.pid), flush=True)
    os.kill(os.getpid(), signal.SIGTERM)
    return task
cw.subprocess.Popen = launch
sys.argv = [sys.argv[1], '/bin/sleep 30']
sys.exit(cw.main())
"""
        process = subprocess.Popen(["/usr/bin/python3", "-c", code,
                                    str(self.root / "hooks/command-watchdog.py")],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env)
        task_pid = None
        try:
            self.assertTrue(select.select([process.stdout], [], [], 10)[0], "launch never completed")
            task_pid = json.loads(process.stdout.readline())
            status = process.wait(timeout=10)
            self.assertFalse(self.is_running(task_pid), "launch cancellation orphaned the task")
            self.assertEqual(status, 128 + signal.SIGTERM)
        finally:
            if task_pid is not None:
                try:
                    os.killpg(task_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
