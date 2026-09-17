#!/usr/bin/env python3
"""PreToolUse (Bash) hook. Every Bash call goes through the same two steps,
in order — there is no longer a pattern-gated fork between them:

  1. Resolve the command to actually run. If `rtk` is on PATH, ask it for its
     token-saving rewrite (`rtk hook claude`) — but run that decision call
     itself under command-watchdog.py with a short WATCHDOG_MAX_RUNTIME cap
     (RTK_MAX_RUNTIME below), not a bare subprocess call. rtk's decision is
     supposed to be near-instant; anything past the cap is rtk's own bug, not
     legitimate work, so this needs a hard wall-clock kill rather than the
     idle-only detection meant for long-running commands (see
     command-watchdog.py's docstring for why those are different tools). If
     rtk denies/blocks the call, or times out, or isn't installed, or its
     output doesn't parse, fall back to the original, unmodified command.
  2. Wrap whatever command resulted from step 1 in command-watchdog.py's
     idle-hang detection (live output + kill-on-flatline), unconditionally.
     watchdog-patterns.txt now only controls the per-command IDLE_LIMIT
     override (e.g. a longer allowance for `rspec` runs) — it no longer
     gates whether wrapping happens at all.

On any error, fall through so a bug here can never block a command.

Invoked via the plugin's absolute /usr/bin/python3 (not a bare `python3`) so
this never gets routed through a version manager's shim — see
command-watchdog.py's module docstring for why that matters.

Diagnostics: `touch` the flag file at DEBUG_FLAG (path below) and re-run a
command; every invocation then appends one line to DEBUG_LOG with the fields
that are otherwise thrown away (matched idle pattern, rtk resolution, PATH,
subprocess returncode/stderr, exact stdout emitted). File-gated rather than
env-gated: hooks inherit Claude Code's launch-time environment, not a later
shell export, so an env var would need a settings.json change plus restart to
toggle — the flag file works with a plain `touch`/`rm` and no restart.
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
WATCHDOG = os.path.join(HERE, "command-watchdog.py")
PATTERNS_FILE = os.path.join(HERE, "watchdog-patterns.txt")
DEFAULT_IDLE = 90
# rtk's rewrite decision should be near-instant (string matching + a small
# rewrite table, no I/O expected). This is a hard wall-clock cap, not an idle
# window — the incident this replaced was a busy CPU-bound loop inside rtk,
# which idle-only detection would never have caught (CPU kept advancing).
RTK_MAX_RUNTIME = 15
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


def resolve_via_rtk(raw, cmd):
    """Ask rtk for its rewrite of `cmd`, running the decision call itself
    under command-watchdog's hard wall-clock cap. Returns (final_cmd,
    passthrough) where `passthrough` is an already-built hook response dict
    to emit verbatim (e.g. an explicit deny from rtk) or None to continue to
    step 2. Never raises — any failure just returns (cmd, None), i.e. use the
    original command unmodified."""
    if not shutil.which("rtk"):
        debug_log({"stage": "rtk-not-found", "path": os.environ.get("PATH")})
        return cmd, None

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, prefix="bash-watchdog-rtk-"
        ) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name

        rtk_cmd = "rtk hook claude < {}".format(shlex.quote(tmp_path))
        env = dict(os.environ)
        env["WATCHDOG_MAX_RUNTIME"] = str(RTK_MAX_RUNTIME)
        env["WATCHDOG_IDLE"] = str(RTK_MAX_RUNTIME)
        result = subprocess.run(
            ["/usr/bin/python3", WATCHDOG, rtk_cmd],
            capture_output=True, text=True, env=env,
        )
        debug_log({
            "stage": "rtk-delegate", "returncode": result.returncode,
            "stdout": result.stdout, "stderr": result.stderr,
        })

        if result.returncode == 124:
            debug_log({"stage": "rtk-timed-out", "max_runtime": RTK_MAX_RUNTIME})
            return cmd, None

        if not result.stdout.strip():
            return cmd, None  # rtk had nothing to add — command passes through as-is

        try:
            rtk_out = json.loads(result.stdout)
        except Exception as e:
            debug_log({"stage": "rtk-output-parse-error", "error": repr(e)})
            return cmd, None

        hook_out = rtk_out.get("hookSpecificOutput", {}) if isinstance(rtk_out, dict) else {}
        decision = hook_out.get("permissionDecision")
        if decision and decision != "allow":
            # rtk made an explicit non-allow call (deny/ask) — respect it
            # verbatim instead of forcing a watchdog wrap on top of it.
            debug_log({"stage": "rtk-non-allow-decision", "decision": decision})
            return cmd, rtk_out

        updated = hook_out.get("updatedInput", {}).get("command")
        return (updated if updated else cmd), None
    except Exception as e:
        debug_log({"stage": "rtk-delegate-error", "error": repr(e)})
        return cmd, None
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


raw = sys.stdin.read()
debug_log({"stage": "invoked", "raw_len": len(raw), "path": os.environ.get("PATH")})

try:
    data = json.loads(raw)
    cmd = str(data.get("tool_input", {}).get("command", ""))
    tool_name = data.get("tool_name")
except Exception as e:
    debug_log({"stage": "parse-error", "error": repr(e)})
    sys.exit(0)  # not valid hook JSON — let the tool call proceed unmodified

if tool_name != "Bash" or WATCHDOG in cmd:
    # Not a Bash call, or this is command-watchdog.py's own child invocation
    # (e.g. the rtk-decision sub-call above) re-entering the hook — never
    # recurse into ourselves.
    debug_log({"stage": "skipped", "tool_name": tool_name, "command": cmd})
    sys.exit(0)

final_cmd, passthrough = resolve_via_rtk(raw, cmd)
if passthrough is not None:
    print(json.dumps(passthrough))
    sys.exit(0)

core = strip_env_prefix(final_cmd)
idle = next((p[1] for p in load_patterns() if p[0].search(core)), DEFAULT_IDLE)
wrapped = "WATCHDOG_IDLE={} /usr/bin/python3 {} {}".format(
    idle, shlex.quote(WATCHDOG), shlex.quote(final_cmd)
)
debug_log({
    "stage": "watchdog-wrap", "tool_name": tool_name, "original_command": cmd,
    "final_command": final_cmd, "idle": idle,
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
