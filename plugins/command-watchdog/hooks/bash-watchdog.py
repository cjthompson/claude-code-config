#!/usr/bin/env python3
"""PreToolUse (Bash) hook. Every Bash call goes through the same two steps,
in order — there is no longer a pattern-gated fork between them:

  1. Resolve the command to actually run. If `rtk` is on PATH, ask it for its
     token-saving rewrite (`rtk hook claude`) — but run that decision call
     itself under command-watchdog.py with a short WATCHDOG_MAX_RUNTIME cap
     (the built-in `rtk` entry in watchdog_config.BUILTIN_COMMANDS), not a bare subprocess call. It is
     passed --rtk-decision, so no [rule:] section applies to it and it writes no stats row. rtk's decision is
     supposed to be near-instant; anything past the cap is rtk's own bug, not
     legitimate work, so this needs a hard wall-clock kill rather than the
     idle-only detection meant for long-running commands (see
     command-watchdog.py's docstring for why those are different tools). If
     rtk denies/blocks the call, or times out, or isn't installed, or its
     output doesn't parse, fall back to the original, unmodified command.
  2. Wrap whatever command resulted from step 1 in command-watchdog.py's
     idle-hang detection (live output + kill-on-flatline), unconditionally.
     Per-command limits live in watchdog-patterns.ini and are resolved by
     command-watchdog.py itself; this wrapper injects no limits. Leading
     `WATCHDOG_*=value` assignments on the command are lifted off the command
     and passed to command-watchdog.py as `--set key=value` arguments.

     The command-watchdog.py invocation is:
       command-watchdog.py --original TEXT [--rtk-proxied] [--set k=v]... -- CMD
     and the rtk decision call is command-watchdog.py --rtk-decision -- RTK_CMD
     TEXT is the command after lifting assignments and before rtk rewriting;
     CMD is the final command, passed as ONE shlex-quoted argv element. A
     command that is only assignments passes through unmodified.

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
import shlex
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
WATCHDOG = os.path.join(HERE, "command-watchdog.py")
sys.path.insert(0, HERE)
from command_identity import lift_overrides  # noqa: E402
from watchdog_config import BUILTIN_COMMANDS  # noqa: E402

# rtk's rewrite decision should be near-instant (string matching + a small
# rewrite table, no I/O expected). The built-in `rtk` entry in BUILTIN_COMMANDS
# caps it as a hard wall-clock limit, not an idle window — the incident this
# replaced was a busy CPU-bound loop inside rtk, which idle-only detection would
# never have caught (CPU kept advancing).

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
        payload = json.loads(raw)
        payload.setdefault("tool_input", {})["command"] = cmd
        raw = json.dumps(payload)
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, prefix="bash-watchdog-rtk-"
        ) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name

        rtk_cmd = "rtk hook claude < {}".format(shlex.quote(tmp_path))
        # The user's WATCHDOG_* settings must not leak into the rtk call. The
        # built-in [command:rtk] entry caps its runtime (BUILTIN_COMMANDS).
        env = {k: v for k, v in os.environ.items() if not k.startswith("WATCHDOG_")}
        result = subprocess.run(
            ["/usr/bin/python3", WATCHDOG, "--rtk-decision", "--", rtk_cmd],
            capture_output=True, text=True, env=env,
        )
        debug_log({
            "stage": "rtk-delegate", "returncode": result.returncode,
            "stdout": result.stdout, "stderr": result.stderr,
        })

        if result.returncode == 124:
            debug_log({"stage": "rtk-timed-out", "max_runtime": BUILTIN_COMMANDS["rtk"]["max_runtime"]})
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

lifted, rejected, remaining = lift_overrides(cmd)
for item in rejected:
    debug_log({"stage": "override-rejected", "assignment": item})
if not remaining:
    debug_log({"stage": "no-command-after-overrides", "original_command": cmd})
    sys.exit(0)  # P5: pass the original text through unmodified

final_cmd, passthrough = resolve_via_rtk(raw, remaining)
if passthrough is not None:
    print(json.dumps(passthrough))
    sys.exit(0)

args = [WATCHDOG, "--original", remaining]
if final_cmd != remaining:
    args.append("--rtk-proxied")
for key, value in lifted.items():
    args += ["--set", "{}={}".format(key, value)]
args += ["--", final_cmd]
wrapped = " ".join(["/usr/bin/python3"] + [shlex.quote(part) for part in args])
debug_log({
    "stage": "watchdog-wrap", "tool_name": tool_name, "original_command": cmd,
    "final_command": final_cmd, "lifted": lifted,
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
