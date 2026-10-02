#!/usr/bin/env python3
"""worktree-guard: keep Claude Code edits out of a repository's main checkout.

Two hook modes, selected by argv[1]:

  pre-tool-use   PreToolUse on Edit|Write|NotebookEdit (Claude Code) and
                 apply_patch (Codex). Resolves the git repository that
                 contains each *edited file* (not the session cwd). If a file
                 lives in a main checkout — the working tree whose git dir is
                 the repository's common dir — the edit is gated. Files in a
                 linked worktree, outside any repository, or inside a bare
                 repository pass silently.

                 Claude Code: `permissionDecision: "ask"`, so the user
                 approves or rejects the edit.
                 Codex: `permissionDecision: "deny"`. Codex parses "ask" but
                 does not support it — it logs a hook failure and lets the
                 edit through — so deny is the only effective gate there.
                 apply_patch carries the patch in tool_input.command; every
                 `*** Add/Update/Delete File:` and `*** Move to:` path is
                 checked.

  session-start  SessionStart. Injects worktree-rule.md as additionalContext
                 so the model knows the policy and the bypass protocol.

Bypass: in Claude Code, the `ask` prompt itself — the user approves it. To
disable the guard for a whole session (the only bypass in Codex), launch the
agent with WORKTREE_GUARD_DISABLE=1 (hooks inherit the launch-time
environment, so a later shell export has no effect).

Fail-open: any unexpected error exits 0 with no output, so a bug here can
never block an edit.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RULE_FILE = os.path.join(HERE, "worktree-rule.md")
PATCH_PATH_RE = re.compile(
    r"^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$", re.MULTILINE)


def nearest_existing_dir(path):
    """Walk up from `path` to the closest directory that exists (Write may
    create new files in new directories)."""
    d = path if os.path.isdir(path) else os.path.dirname(path)
    while d and not os.path.isdir(d):
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent
    return d or None


def main_checkout_root(directory):
    """Return the work-tree root if `directory` is inside a repository's main
    checkout, else None."""
    try:
        out = subprocess.run(
            ["git", "-C", directory, "rev-parse", "--path-format=absolute",
             "--is-inside-work-tree", "--git-common-dir", "--git-dir", "--show-toplevel"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    lines = out.stdout.splitlines()
    if len(lines) < 4 or lines[0] != "true":
        return None
    common, gitdir, toplevel = (os.path.realpath(p) for p in lines[1:4])
    return toplevel if common == gitdir else None


def target_paths(payload):
    """Return (paths, is_codex) for the edit described by `payload`."""
    tool_input = payload.get("tool_input") or {}
    if payload.get("tool_name") == "apply_patch":
        patch = tool_input.get("command")
        if not isinstance(patch, str):
            patch = tool_input.get("input") if isinstance(tool_input.get("input"), str) else ""
        return PATCH_PATH_RE.findall(patch), True
    target = tool_input.get("file_path") or tool_input.get("notebook_path")
    return ([target] if target else []), False


def pre_tool_use(payload):
    if os.environ.get("WORKTREE_GUARD_DISABLE") == "1":
        return
    paths, is_codex = target_paths(payload)
    cwd = payload.get("cwd") or os.getcwd()
    hits = []
    for path in paths:
        target = os.path.normpath(os.path.join(cwd, os.path.expanduser(path)))
        directory = nearest_existing_dir(target)
        root = main_checkout_root(directory) if directory else None
        if root:
            hits.append((target, root))
    if not hits:
        return
    roots = sorted({root for _, root in hits})
    files = ", ".join(target for target, _ in hits)
    reason = (
        f"{files} {'is' if len(hits) == 1 else 'are'} in the main checkout of "
        f"{', '.join(roots)}. Work in a worktree (git worktree add ../<branch>) "
        "unless the user said otherwise."
    )
    if is_codex:
        reason += (" Codex cannot prompt, so this edit is blocked; the user can "
                   "relaunch with WORKTREE_GUARD_DISABLE=1 to allow main-checkout edits.")
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny" if is_codex else "ask",
        "permissionDecisionReason": reason,
    }}))


def session_start(_payload):
    if os.environ.get("WORKTREE_GUARD_DISABLE") == "1":
        return
    with open(RULE_FILE, encoding="utf-8") as f:
        rule = f.read()
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": rule,
    }}))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if mode == "pre-tool-use":
            pre_tool_use(payload)
        elif mode == "session-start":
            session_start(payload)
    except Exception:  # fail open
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
