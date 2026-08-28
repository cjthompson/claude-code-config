#!/usr/bin/env python3
"""PreToolUse (Bash) hook. Two jobs:
  1. If the command matches a pattern in watchdog-patterns.txt, run it under
     command-watchdog.py (idle-hang detection + live output). The watchdog
     spawns the command as a plain child process, so it never re-enters
     this hook (no recursion).
  2. For everything else, delegate to `rtk hook claude` if rtk is installed,
     preserving its token-saving output compaction. If rtk isn't on PATH,
     fall through and let the tool call run unmodified.

On any error, fall through so a bug here can never block a command.

Invoked via the plugin's absolute /usr/bin/python3 (not a bare `python3`) so
this never gets routed through a version manager's shim — see
command-watchdog.py's module docstring for why that matters.

Diagnostics: both `except` blocks above swallow silently by design, so a
broken hook and a working-but-declining-to-rewrite hook look identical from
the outside. To tell them apart, `touch` the flag file at DEBUG_FLAG (path
below) and re-run a command; every invocation then appends one line to
DEBUG_LOG with the fields that are otherwise thrown away (matched pattern,
`rtk` resolution, PATH, subprocess returncode/stderr, exact stdout emitted).
File-gated rather than env-gated: hooks inherit Claude Code's launch-time
environment, not a later shell export, so an env var would need a
settings.json change plus restart to toggle — the flag file works with a
plain `touch`/`rm` and no restart.
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
WATCHDOG = os.path.join(HERE, "command-watchdog.py")
PATTERNS_FILE = os.path.join(HERE, "watchdog-patterns.txt")
DEFAULT_IDLE = 90
# Fixed /tmp path (not tempfile.gettempdir(), which resolves per-session via
# $TMPDIR on macOS — unguessable, so `touch`/`cat` from a shell wouldn't hit it).
DEBUG_FLAG = "/tmp/command-watchdog-debug.on"
DEBUG_LOG = "/tmp/command-watchdog-debug.log"


def debug_log(fields):
    """Best-effort append; must never raise or block the real hook logic."""
    try:
        if not os.path.exists(DEBUG_FLAG):
            return
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        line = ts + " " + " ".join("{}={!r}".format(k, v) for k, v in fields.items())
        with open(DEBUG_LOG, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


def load_patterns():
    """Load [regex, idle_seconds] pairs from the patterns file. A trailing
    all-digit token is the per-pattern idle override; the rest of the line is
    the regex (so regexes may contain spaces). Bad regexes are skipped, not
    fatal."""
    if not os.path.isfile(PATTERNS_FILE):
        return []

    patterns = []
    with open(PATTERNS_FILE) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue

            m = re.fullmatch(r"(.*?)\s+(\d+)", line)
            pattern, idle = (m.group(1), int(m.group(2))) if m else (line, DEFAULT_IDLE)
            try:
                patterns.append((re.compile(pattern), idle))
            except re.error:
                continue
    return patterns


def strip_env_prefix(cmd):
    """Strip leading `VAR=val` env assignments so patterns can anchor on the
    real command (the env prefix is preserved in the actual wrapped command)."""
    return re.sub(r"\A\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*", "", cmd)


raw = sys.stdin.read()
debug_log({"stage": "invoked", "raw_len": len(raw), "path": os.environ.get("PATH")})

try:
    data = json.loads(raw)
    cmd = str(data.get("tool_input", {}).get("command", ""))
    tool_name = data.get("tool_name")
    if tool_name == "Bash" and WATCHDOG not in cmd:
        core = strip_env_prefix(cmd)
        match = next((p for p in load_patterns() if p[0].search(core)), None)
        if match:
            idle = match[1]
            wrapped = "WATCHDOG_IDLE={} /usr/bin/python3 {} {}".format(
                idle, shlex.quote(WATCHDOG), shlex.quote(cmd)
            )
            debug_log({
                "stage": "watchdog-wrap", "tool_name": tool_name, "command": cmd,
                "matched_pattern": match[0].pattern, "idle": idle,
            })
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow",
                    "permissionDecisionReason": "command watchdog wrap",
                    "updatedInput": {"command": wrapped},
                }
            }))
            sys.exit(0)
        debug_log({"stage": "no-pattern-match", "tool_name": tool_name, "command": cmd})
    else:
        debug_log({"stage": "skipped", "tool_name": tool_name, "command": cmd})
except Exception as e:
    debug_log({"stage": "parse-error", "error": repr(e)})
    pass  # fall through to rtk (or pass-through)

try:
    rtk_path = shutil.which("rtk")
    result = subprocess.run(
        ["rtk", "hook", "claude"], input=raw, capture_output=True, text=True
    )
    debug_log({
        "stage": "rtk-delegate", "rtk_path": rtk_path, "returncode": result.returncode,
        "stdout": result.stdout, "stderr": result.stderr,
    })
    print(result.stdout, end="")
    sys.exit(result.returncode)
except FileNotFoundError:
    debug_log({"stage": "rtk-not-found", "path": os.environ.get("PATH")})
    sys.exit(0)  # rtk not installed — let the tool call proceed unmodified
