"""Tests for worktree-guard.py.

Run: /usr/bin/python3 -m unittest discover -s plugins/worktree-guard/tests -v
"""
import json
import os
import subprocess
import tempfile
import unittest

GUARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks", "worktree-guard.py")


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def run_guard(mode, payload, **env):
    r = subprocess.run(
        ["/usr/bin/python3", GUARD, mode],
        input=json.dumps(payload), capture_output=True, text=True,
        env=dict(os.environ, **env), timeout=30,
    )
    return r.returncode, r.stdout.strip()


def edit(path, cwd="/", tool="Edit"):
    key = "notebook_path" if tool == "NotebookEdit" else "file_path"
    return {"tool_name": tool, "cwd": cwd, "tool_input": {key: path}}


class GuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        base = os.path.realpath(cls.tmp.name)
        cls.main = os.path.join(base, "repo")
        cls.wt = os.path.join(base, "repo-wt")
        cls.outside = os.path.join(base, "plain")
        os.makedirs(cls.main)
        os.makedirs(cls.outside)
        git(cls.main, "init", "-q", "-b", "main")
        git(cls.main, "-c", "user.email=t@t", "-c", "user.name=t",
            "commit", "-q", "--allow-empty", "-m", "init")
        git(cls.main, "worktree", "add", "-q", "-b", "feat", cls.wt)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def assert_ask(self, payload):
        code, out = run_guard("pre-tool-use", payload)
        self.assertEqual(code, 0)
        data = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(data["permissionDecision"], "ask")
        self.assertIn(self.main, data["permissionDecisionReason"])

    def assert_allow(self, payload, **env):
        code, out = run_guard("pre-tool-use", payload, **env)
        self.assertEqual((code, out), (0, ""))

    def test_main_checkout_asks(self):
        self.assert_ask(edit(os.path.join(self.main, "README.md")))

    def test_new_file_in_new_dir_in_main_asks(self):
        self.assert_ask(edit(os.path.join(self.main, "a", "b", "new.txt"), tool="Write"))

    def test_notebook_in_main_asks(self):
        self.assert_ask(edit(os.path.join(self.main, "n.ipynb"), tool="NotebookEdit"))

    def test_relative_path_resolved_against_payload_cwd(self):
        self.assert_ask(edit("README.md", cwd=self.main))

    def test_worktree_allows(self):
        self.assert_allow(edit(os.path.join(self.wt, "README.md")))

    def test_main_target_from_worktree_session_asks(self):
        # Decision follows the file, not the session cwd.
        self.assert_ask(edit(os.path.join(self.main, "README.md"), cwd=self.wt))

    def test_worktree_target_from_main_session_allows(self):
        self.assert_allow(edit(os.path.join(self.wt, "README.md"), cwd=self.main))

    def test_outside_repo_allows(self):
        self.assert_allow(edit(os.path.join(self.outside, "x.txt"), cwd=self.main))

    def test_disable_env_allows(self):
        self.assert_allow(edit(os.path.join(self.main, "README.md")), WORKTREE_GUARD_DISABLE="1")

    def test_garbage_input_fails_open(self):
        r = subprocess.run(["/usr/bin/python3", GUARD, "pre-tool-use"],
                           input="not json", capture_output=True, text=True, timeout=30)
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def patch_payload(self, *headers, cwd="/"):
        body = "\n".join(["*** Begin Patch", *headers, "+x", "*** End Patch"])
        return {"tool_name": "apply_patch", "cwd": cwd, "turn_id": "t1",
                "tool_input": {"command": body}}

    def assert_codex_deny(self, payload):
        code, out = run_guard("pre-tool-use", payload)
        self.assertEqual(code, 0)
        data = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(data["permissionDecision"], "deny")
        self.assertIn(self.main, data["permissionDecisionReason"])
        self.assertIn("WORKTREE_GUARD_DISABLE=1", data["permissionDecisionReason"])
        return data

    def test_codex_patch_in_main_denies(self):
        self.assert_codex_deny(self.patch_payload(f"*** Update File: {self.main}/README.md"))

    def test_codex_relative_add_in_main_denies(self):
        self.assert_codex_deny(self.patch_payload("*** Add File: src/new.py", cwd=self.main))

    def test_codex_patch_in_worktree_allows(self):
        self.assert_allow(self.patch_payload(f"*** Update File: {self.wt}/README.md", cwd=self.main))

    def test_codex_mixed_patch_denies_and_names_only_main_file(self):
        data = self.assert_codex_deny(self.patch_payload(
            f"*** Update File: {self.wt}/a.txt",
            f"*** Delete File: {self.main}/b.txt"))
        self.assertNotIn(f"{self.wt}/a.txt", data["permissionDecisionReason"])

    def test_codex_move_into_main_denies(self):
        self.assert_codex_deny(self.patch_payload(
            f"*** Update File: {self.wt}/a.txt", f"*** Move to: {self.main}/a.txt"))

    def test_codex_disable_env_allows(self):
        self.assert_allow(self.patch_payload(f"*** Update File: {self.main}/README.md"),
                          WORKTREE_GUARD_DISABLE="1")

    def test_session_start_injects_rule(self):
        code, out = run_guard("session-start", {"cwd": self.main})
        self.assertEqual(code, 0)
        data = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(data["hookEventName"], "SessionStart")
        self.assertIn("Worktree rule", data["additionalContext"])


if __name__ == "__main__":
    unittest.main()
