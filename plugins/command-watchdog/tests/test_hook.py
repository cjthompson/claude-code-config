"""Exercise the shared hook's wire protocol and command lifecycle."""
import json
import os
from pathlib import Path
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
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
                        WATCHDOG_IDLE="90", WATCHDOG_POLL="1", WATCHDOG_MAX_RUNTIME="0")

    def rewrite(self, command, host="codex"):
        payload = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
                   "tool_input": {"command": command}, "cwd": self.temporary.name,
                   "session_id": "hook-test", "tool_use_id": "call-test"}
        env = dict(self.env)
        if host == "codex":
            payload["turn_id"] = "turn-test"
            env["PLUGIN_ROOT"] = str(self.root)
        config = json.loads((self.root / "hooks/hooks.json").read_text())
        hook_command = config["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        result = subprocess.run(["/bin/sh", "-c", hook_command], input=json.dumps(payload),
                                text=True, capture_output=True, env=env, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)["hookSpecificOutput"]
        self.assertEqual(output["hookEventName"], "PreToolUse")
        self.assertEqual(output["permissionDecision"], "allow")
        wrapped = output["updatedInput"]["command"]
        self.assertEqual(shlex.split(wrapped)[-1], command)
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


if __name__ == "__main__":
    unittest.main()
