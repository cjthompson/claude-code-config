#!/usr/bin/env python3
"""command-watchdog.py — run any command, tee its output live, and kill it if
it goes IDLE (no stdout/stderr output AND no CPU progress) for a sustained
window.

Usage:  python3 command-watchdog.py <command string...>

Detection model:
  - An idle timer resets on ANY activity in a poll window:
      * new output on the child's stdout/stderr, OR
      * the child process GROUP's cumulative CPU time advancing.
  - A hang is declared only when BOTH stay flat for WATCHDOG_IDLE seconds.
  This lets a slow-but-working command (silent, but burning CPU) keep the
  timer alive, while a true deadlock/IO-wait (silent AND cpu-flat) trips fast.

This handles the IDLE case. A CPU-bound infinite loop (busy but stuck) is NOT
idle by this definition — CPU keeps advancing — so it is caught instead by
WATCHDOG_MAX_RUNTIME below, a hard wall-clock cap applied regardless of
activity. Leave it unset (default) for commands with legitimate long
runtimes (test suites, builds); set it short for calls that should always be
near-instant (e.g. a hook's own rewrite-decision step), where any runtime
past the cap is itself the bug, not real work.

A third, independent trigger: orphan detection. This process records its
ppid at startup; every poll (≤1s) it re-checks os.getppid(). If that value
changes, our original parent (whatever invoked this script — Claude Code's
own process, or the PreToolUse hook process for the rtk-decision sub-call)
has exited and we've been reparented (to launchd/init or a subreaper). That
parent is never coming back to read our output or care about our result, so
there is no reason to wait out IDLE_LIMIT or MAX_RUNTIME — the child process
group is killed immediately. This is what actually bounds a CPU-bound spin
loop left running by a crashed/killed parent (e.g. a force-quit Claude Code
session): MAX_RUNTIME is disabled by default for long-running commands and
IDLE_LIMIT never trips on a busy loop, so without this check an orphaned
spin loop would burn 100% CPU indefinitely, exactly as observed in the
incident that prompted this file.

Env overrides:
  WATCHDOG_IDLE         idle window in seconds (default 90)
  WATCHDOG_POLL         CPU sampling interval in seconds (default 5)
  WATCHDOG_MAX_RUNTIME  hard wall-clock cap in seconds, kills regardless of
                        output/CPU activity (default 0 = disabled)

Invoked via /usr/bin/python3 (the system interpreter), deliberately bypassing
any `mise`/`pyenv`/etc. shim: this process's env (PATH, GEM_HOME, ...) is
inherited unchanged by the spawned child below, so a version-manager shim
resolving *this* interpreter's version would pin that resolution for the
child too, before the child's own `cd`/tool invocations get a chance to
resolve their own directory-local versions. Using the always-present system
interpreter sidesteps that entirely.

Diagnostics: shares bash-watchdog.py's toggle — `touch` DEBUG_FLAG and every
run appends to DEBUG_LOG (same path, so the wrap decision and the watchdog's
own lifecycle interleave in one chronological file). Covers what's otherwise
silently swallowed: missing `ps`/`sample` on this machine, a kill signal that
didn't land, and the exit-code coercion when the child died from a signal
(negative returncode) rather than exiting normally.
"""
import os
import re
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

IDLE_LIMIT = int(os.environ.get("WATCHDOG_IDLE", "90"))
POLL = int(os.environ.get("WATCHDOG_POLL", "5"))
MAX_RUNTIME = int(os.environ.get("WATCHDOG_MAX_RUNTIME", "0"))  # 0 = disabled
CPU_EPSILON = 0.05  # seconds of CPU advance that counts as "still working"
PARENT_PID = os.getppid()  # captured before our own parent can possibly exit
DEBUG_FLAG = "/tmp/command-watchdog-debug.on"
DEBUG_LOG = "/tmp/command-watchdog-debug.log"


def debug_log(fields):
    """Best-effort append; must never raise or interfere with kill/exit logic."""
    try:
        if not os.path.exists(DEBUG_FLAG):
            return
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        line = ts + " " + " ".join("{}={!r}".format(k, v) for k, v in fields.items())
        with open(DEBUG_LOG, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass

cmd = " ".join(sys.argv[1:]).strip()
if not cmd:
    print("command-watchdog: no command given", file=sys.stderr)
    sys.exit(2)


def parse_cpu_time(field):
    """Parse a `ps` TIME field ([[DD-]HH:]MM:SS.ss) into seconds."""
    days = 0
    if "-" in field:
        d, field = field.split("-", 1)
        days = int(d)
    secs = 0.0
    for part in field.split(":"):
        secs = secs * 60 + float(part)
    return days * 86_400 + secs


def group_cpu(pgid):
    """Sum cumulative CPU seconds across the process group; also return the
    pid burning the most CPU (best target for a stack sample on hang)."""
    total = 0.0
    busiest = None
    busiest_cpu = -1.0
    try:
        out = subprocess.run(
            ["ps", "-A", "-o", "pid=,pgid=,time="], capture_output=True, text=True
        ).stdout
    except FileNotFoundError:
        debug_log({"stage": "ps-unavailable"})
        return total, busiest
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 3:
            continue
        pid_s, pgid_s, time_s = parts
        if int(pgid_s) != pgid:
            continue
        c = parse_cpu_time(time_s)
        total += c
        if c > busiest_cpu:
            busiest_cpu = c
            busiest = int(pid_s)
    return total, busiest


def dump_diagnostics(pgid, busiest, reason):
    debug_log({
        "stage": "hang-detected", "pgid": pgid, "busiest": busiest, "reason": reason,
        "idle_limit": IDLE_LIMIT, "max_runtime": MAX_RUNTIME,
    })
    out = "\n\n=== command-watchdog: HANG DETECTED ({}) ===\n".format(reason)
    if reason == "orphaned":
        out += "Parent process (pid {}) exited — we've been reparented to pid {}; killing rather than waiting it out (process group {}).\n\n".format(
            PARENT_PID, os.getppid(), pgid
        )
    elif reason == "max-runtime":
        out += "Hard wall-clock cap of {}s reached regardless of activity (process group {}).\n\n".format(
            MAX_RUNTIME, pgid
        )
    else:
        out += "No output and no CPU progress for {}s (process group {}).\n\n".format(
            IDLE_LIMIT, pgid
        )
    out += "Process group tree:\n"
    try:
        ps_out = subprocess.run(
            ["ps", "-A", "-o", "pid=,ppid=,pgid=,%cpu=,time=,command="],
            capture_output=True, text=True,
        ).stdout
    except FileNotFoundError:
        ps_out = ""
    for line in ps_out.splitlines(keepends=True):
        fields = line.strip().split(None, 5)
        if len(fields) > 2 and fields[2].isdigit() and int(fields[2]) == pgid:
            out += line
    if busiest:
        out += "\nStack sample of busiest pid {}:\n".format(busiest)
        try:
            sample_out = subprocess.run(
                ["sample", str(busiest), "2"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            ).stdout
        except FileNotFoundError:
            debug_log({"stage": "sample-unavailable"})
            sample_out = ""
        out += sample_out[:6000]
    out += "\n=== killing process group {} ===\n".format(pgid)
    sys.stdout.write(out)
    sys.stdout.flush()


# Launch the child in its OWN process group so we can signal the whole tree
# (e.g. a test runner + any forked browsers/vite). pgid == pid.
r_fd, w_fd = os.pipe()
proc = subprocess.Popen(
    ["/bin/bash", "-c", cmd], stdout=w_fd, stderr=w_fd, preexec_fn=os.setpgrp
)
os.close(w_fd)
pgid = os.getpgid(proc.pid)
debug_log({"stage": "cw-start", "cmd": cmd, "idle_limit": IDLE_LIMIT, "poll": POLL, "pid": proc.pid, "pgid": pgid})

lock = threading.Lock()
last_activity = time.time()


def reader():
    global last_activity
    while True:
        try:
            chunk = os.read(r_fd, 65_536)
        except OSError:
            return
        if not chunk:
            return
        os.write(1, chunk)
        with lock:
            last_activity = time.time()


reader_thread = threading.Thread(target=reader, daemon=True)
reader_thread.start()

hung = False
last_cpu = 0.0
last_cpu_check = time.time()
start_time = time.time()

while True:
    returncode = proc.poll()
    if returncode is not None:
        break

    time.sleep(1)  # keep exit-latency <=1s; CPU sampling happens every POLL below
    now = time.time()

    if now - last_cpu_check >= POLL:
        last_cpu_check = now
        cpu, _ = group_cpu(pgid)
        if cpu - last_cpu > CPU_EPSILON:
            last_cpu = cpu
            with lock:
                last_activity = now  # CPU progressed -> still alive

    with lock:
        idle = now - last_activity

    if os.getppid() != PARENT_PID:
        reason = "orphaned"
    elif MAX_RUNTIME and (now - start_time) >= MAX_RUNTIME:
        reason = "max-runtime"
    elif idle >= IDLE_LIMIT:
        reason = "idle"
    else:
        continue

    hung = True
    _, busiest = group_cpu(pgid)
    dump_diagnostics(pgid, busiest, reason)
    # Signal the whole group via a negative pid (killpg-equivalent). Ignore
    # ProcessLookupError (already gone) and PermissionError (a group member we
    # can't signal); the KILL escalation and the direct-pid fallback cover
    # stragglers.
    for sig, target in ((signal.SIGTERM, -pgid), (signal.SIGTERM, proc.pid)):
        try:
            os.kill(target, sig)
        except (ProcessLookupError, PermissionError) as e:
            debug_log({"stage": "kill-signal-failed", "sig": "SIGTERM", "target": target, "error": type(e).__name__})
    time.sleep(3)
    for sig, target in ((signal.SIGKILL, -pgid), (signal.SIGKILL, proc.pid)):
        try:
            os.kill(target, sig)
        except (ProcessLookupError, PermissionError) as e:
            debug_log({"stage": "kill-signal-failed", "sig": "SIGKILL", "target": target, "error": type(e).__name__})
    try:
        proc.wait()
    except Exception:
        pass
    break

reader_thread.join(2)
try:
    os.close(r_fd)
except OSError:
    pass

if hung:
    debug_log({"stage": "cw-exit", "hung": True, "proc_returncode": proc.returncode, "exit_code": 124})
    sys.exit(124)
exit_code = proc.returncode if proc.returncode is not None and proc.returncode >= 0 else 1
debug_log({"stage": "cw-exit", "hung": False, "proc_returncode": proc.returncode, "exit_code": exit_code})
sys.exit(exit_code)
