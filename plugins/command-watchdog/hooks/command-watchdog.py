#!/usr/bin/python3
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

Poll mode — sleeping `until` / `while` loops with a simple `pgrep`,
`grep -q`, or file-test condition:
  A wait loop's own output (`echo -n .`) and its helpers' CPU (`pgrep`,
  `grep`, `sleep`) say nothing about the work it waits on, which usually runs
  outside our process group. Left to the rules above such a loop never goes
  idle — six-plus-hour hangs were observed. So when the command is a wait
  loop, activity is instead measured on the loop's TARGETS, parsed from the
  command text:
    * `pgrep [OPTIONS] [--] PATTERN` — PIDs selected by pgrep itself (including
      user and parent filters), excluding watchdog processes, our own group,
      our ancestors, other wait-loop shells, and their checker helpers.
      `pgrep -f` skips only its own
      ancestors, so it matches OTHER wait loops' shells — their argv contain
      the pattern text — and loops keep each other waiting forever. An inline
      shell running real work (`bash -lc 'bin/tapioca …'`) still counts. Real
      matches' CPU, including their descendants', counts as activity. New
      workers with accrued CPU count even if no earlier sample saw their PID.
      Patterns that can't be parsed with confidence (shell expansion,
      unbalanced quotes) are skipped rather than guessed. A direct
      wait-for-exit condition (`until ! pgrep` or `while pgrep`) with no real
      match for TARGET_GONE_GRACE (or one full `sleep N` cycle plus two
      samples, if longer) means the loop should have exited. In that case the
      loop is killed ("target-gone") unless
      a file target or in-group work process is still active.
    * file paths (`/…`, `~/…`, `./…`; relative ones resolved through any
      `cd` earlier in the command) — size/mtime changes count, as does CPU
      from non-helper processes holding the file open (`lsof`). Files the
      loop itself writes (`>`, `>>`, `tee`) are ignored, as are patterns and
      paths the shell would expand (`$var`, backticks).
    * work processes inside our own group — non-shell, non-helper, alive at
      least two samples. Their CPU counts, and loop output counts only while
      one exists.
  If none of these move for WATCHDOG_IDLE the loop is killed ("poll-idle").
  A recognized wait loop with no parseable target keeps the default rules but gets a
  WATCHDOG_POLL_CAP wall-clock cap (default 1800s) unless
  WATCHDOG_MAX_RUNTIME is already set.

Env overrides:
  WATCHDOG_IDLE         idle window in seconds (default 90)
  WATCHDOG_POLL         CPU sampling interval in seconds (default 5)
  WATCHDOG_MAX_RUNTIME  hard wall-clock cap in seconds, kills regardless of
                        output/CPU activity (default 0 = disabled)
  WATCHDOG_POLL_CAP     wall-clock cap for wait loops with no parseable
                        target (default 1800)

The child command always starts at the lowest CPU priority (niceness 20 on
macOS, 19 elsewhere), inherited by everything it spawns. WATCHDOG_NICE is
ignored. If setting priority fails, the command is not executed. The watchdog
itself keeps its inherited priority so hang detection stays responsive under load.

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
import shlex
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Dict, List, NamedTuple, Optional, Set, Tuple

IDLE_LIMIT = int(os.environ.get("WATCHDOG_IDLE", "90"))
POLL = int(os.environ.get("WATCHDOG_POLL", "5"))
MAX_RUNTIME = int(os.environ.get("WATCHDOG_MAX_RUNTIME", "0"))  # 0 = disabled
POLL_CAP = int(os.environ.get("WATCHDOG_POLL_CAP", "1800"))
NICE = 20 if sys.platform == "darwin" else 19
CPU_EPSILON = 0.05  # seconds of CPU advance that counts as "still working"
TARGET_GONE_GRACE = 3 * POLL
PARENT_PID = os.getppid()  # captured before our own parent can possibly exit
DEBUG_FLAG = "/tmp/command-watchdog-debug.on"
DEBUG_LOG = "/tmp/command-watchdog-debug.log"
WATCHDOG_NAME = "command-watchdog.py"

SHELLS = {"bash", "zsh", "sh", "dash", "ksh", "fish"}
# Short-lived commands a wait loop runs to check its condition; their CPU and
# lifetime are the loop's own overhead, never the work being waited on.
HELPERS = {
    "sleep", "pgrep", "pkill", "grep", "egrep", "fgrep", "rg", "tail", "head",
    "cat", "ps", "test", "[", "wc", "awk", "sed", "date", "echo", "rtk",
    "lsof", "find", "ls", "stat", "true", "false", "printf",
}

LOOP_HEADER_RE = re.compile(r"\b(until|while)\b(?P<condition>.*?)\bdo\b", re.DOTALL)
DIRECT_PGREP_RE = re.compile(r"^\s*(!\s*)?(?:/usr/bin/)?pgrep\b")
FILE_WAIT_RE = re.compile(r"^\s*(?:!\s*)?(?:(?:/usr/bin/)?grep\s+-\S*q\b|(?:test|\[)\s+-[sfe]\b)")
SLEEP_ONLY_LOOP_RE = re.compile(
    r"\b(?:while\s+true|until\s+false)\s*;\s*do\s*sleep\s+\d+(?:\.\d+)?[smhd]?\s*;\s*done\b"
)
# macOS pgrep options that take an operand (`-u user`, `-P ppid`, ...).
PGREP_ARG_FLAGS = set("FGgPtUu")
PGREP_SIMPLE_FLAGS = set("fiqx")
SLEEP_RE = re.compile(r"\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b")
_PATH_START = r"(?:/|~/|\./)"
PATH_RE = re.compile(
    r"(?<![\w$])(?:'(" + _PATH_START + r"[^']*)'|\"(" + _PATH_START + r"[^\"]*)\"|("
    + _PATH_START + r"[^\s'\";|&<>()`]+))"
)
SHELL_EXPANSION_RE = re.compile(r"\$[A-Za-z_{(0-9@*#?!$-]|`")


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


def parse_cpu_time(field: str) -> float:
    """Parse a `ps` TIME/ETIME field ([[DD-]HH:]MM:SS[.ss]) into seconds."""
    days = 0
    if "-" in field:
        d, field = field.split("-", 1)
        days = int(d)
    secs = 0.0
    for part in field.split(":"):
        secs = secs * 60 + float(part)
    return days * 86_400 + secs


class Proc(NamedTuple):
    pid: int
    ppid: int
    pgid: int
    etime: float
    cpu: float
    command: str

    @property
    def name(self) -> str:
        first = self.command.split(None, 1)[0] if self.command else ""
        return os.path.basename(first).lstrip("-")


def snapshot() -> List[Proc]:
    try:
        out = subprocess.run(
            ["ps", "-A", "-o", "pid=,ppid=,pgid=,etime=,time=,command="],
            capture_output=True, text=True,
        ).stdout
    except FileNotFoundError:
        debug_log({"stage": "ps-unavailable"})
        return []
    procs = []
    for line in out.splitlines():
        parts = line.strip().split(None, 5)
        if len(parts) < 5:
            continue
        try:
            procs.append(Proc(
                int(parts[0]), int(parts[1]), int(parts[2]),
                parse_cpu_time(parts[3]), parse_cpu_time(parts[4]),
                parts[5] if len(parts) > 5 else "",
            ))
        except ValueError:
            continue
    return procs


def group_cpu(pgid: int, procs: Optional[List[Proc]] = None) -> Tuple[float, Optional[int]]:
    """Sum cumulative CPU seconds across the process group; also return the
    pid burning the most CPU (best target for a stack sample on hang)."""
    if procs is None:
        procs = snapshot()
    total = 0.0
    busiest = None
    busiest_cpu = -1.0
    for p in procs:
        if p.pgid != pgid:
            continue
        total += p.cpu
        if p.cpu > busiest_cpu:
            busiest_cpu = p.cpu
            busiest = p.pid
    return total, busiest


def shell_kind(p: Proc) -> Optional[str]:
    """None for non-shells; else "inline" (`-c STRING`), "script" (`bash
    foo.sh`), or "interactive" (no operand, e.g. a login `-zsh`)."""
    if p.name not in SHELLS:
        return None
    words = p.command.split()[1:]
    i = 0
    while i < len(words):
        tok = words[i]
        if tok.startswith("--"):
            i += 1
            continue
        if tok in ("-o", "-O"):
            i += 2  # the following word names a shell option, not a script
            continue
        if tok.startswith("-"):
            if "c" in tok[1:]:
                return "inline"
            i += 1
            continue
        return "script"
    return "interactive"


def is_inline_shell(p: Proc) -> bool:
    """A shell running a `-c` string or interactively — never work inside our
    own group. A shell running a script path (`bash fresheyes.sh`) is."""
    return shell_kind(p) in ("inline", "interactive")


def is_noise(p: Proc) -> bool:
    """Inline shells, loop helpers, and other watchdog instances — processes
    whose argv may contain a target pattern but which are never the real work."""
    return is_inline_shell(p) or p.name in HELPERS or WATCHDOG_NAME in p.command


# --- poll-mode target parsing -------------------------------------------------

def is_waiter(p: Proc) -> bool:
    """Processes that can match a `pgrep -f` pattern without being the awaited
    work: watchdogs, interactive shells, and inline shells that are themselves
    wait loops (their argv holds the loop text, pattern included).
    An inline shell running real work (`bash -lc 'bin/tapioca …'`) is a target."""
    if WATCHDOG_NAME in p.command:
        return True
    kind = shell_kind(p)
    return kind == "interactive" or (kind == "inline" and is_checker_loop(p.command))


class PgrepTarget(NamedTuple):
    full: bool      # -f: match against the full command line, not the name
    negated: bool   # `! pgrep` in the shell condition
    wait_for_exit: bool
    source: str
    args: Tuple[str, ...]  # pass to pgrep so its filters and regex semantics apply


def loop_text(cmd: str) -> str:
    """Command text before any heredoc — a heredoc body is data, not the loop."""
    return cmd.split("<<", 1)[0]


def wait_loop_headers(cmd: str) -> List[Tuple[str, str]]:
    """Only known polling conditions qualify. Throttled work loops still
    produce meaningful output and must use the ordinary idle detector."""
    text = loop_text(cmd)
    headers = []
    for m in LOOP_HEADER_RE.finditer(text):
        condition = m.group("condition")
        end = re.search(r"\bdone\b", text[m.end():])
        if end is None or not re.search(r"\bsleep\b", text[m.end():m.end() + end.start()]):
            continue
        # A compound condition may do work or reverse the check's result.
        # Redirections such as `>/dev/null 2>&1` remain safe to inspect.
        if "&&" in condition or "||" in condition or "$(" in condition or "|" in condition or re.search(r";\s*\S", condition):
            continue
        if DIRECT_PGREP_RE.match(condition) or FILE_WAIT_RE.match(condition):
            headers.append((m.group(1), condition))
    return headers


def is_poll_loop(cmd: str) -> bool:
    return bool(wait_loop_headers(cmd))


def is_checker_loop(cmd: str) -> bool:
    """An inline shell whose command text is just waiting, not doing work."""
    return is_poll_loop(cmd) or bool(SLEEP_ONLY_LOOP_RE.search(loop_text(cmd)))


def _pgrep_args(rest: str) -> Optional[List[str]]:
    """Shell words of one pgrep invocation, up to the first operator."""
    lex = shlex.shlex(rest, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    words = []
    try:
        for tok in lex:
            if tok and all(c in "();<>|&" for c in tok):
                break
            words.append(tok)
    except ValueError:  # unbalanced quotes
        return None
    return words


def parse_pgrep_targets(cmd: str) -> List[PgrepTarget]:
    """Anything we can't parse with confidence is skipped — a wrong pattern
    would make a live target look gone."""
    targets = []
    for loop_kind, condition in wait_loop_headers(cmd):
        m = DIRECT_PGREP_RE.match(condition)
        if m is None:
            continue
        words = _pgrep_args(condition[m.end():])
        if words is None:
            continue
        flags = set()
        pattern = None
        end = 0
        valid = True
        probe = []
        i = 0
        while i < len(words):
            w = words[i]
            if w == "--":
                pattern = words[i + 1] if i + 1 < len(words) else None
                end = i + 2
                if pattern:
                    probe.extend(("--", pattern))
                break
            if w.startswith("-") and len(w) > 1:
                for j, ch in enumerate(w[1:]):
                    if ch not in PGREP_SIMPLE_FLAGS and ch not in PGREP_ARG_FLAGS:
                        valid = False
                        break
                    flags.add(ch)
                    if ch in PGREP_ARG_FLAGS:
                        if j != len(w) - 2 or i + 1 >= len(words):
                            valid = False
                        else:
                            probe.append("-" + w[1:].replace("q", ""))
                            i += 1  # operand is the next word
                            probe.append(words[i])
                        break
                if not valid:
                    break
                if not any(ch in PGREP_ARG_FLAGS for ch in w[1:]):
                    retained = w[1:].replace("q", "")
                    if retained:
                        probe.append("-" + retained)
                i += 1
                continue
            pattern = w
            end = i + 1
            probe.append(w)
            break
        # Shell expansion (`$pat`, backticks) means the text isn't what pgrep sees.
        if not valid or not pattern or any(SHELL_EXPANSION_RE.search(w) for w in words[:end]):
            continue
        negated = bool(m.group(1))
        targets.append(PgrepTarget("f" in flags, negated, (loop_kind == "until") == negated,
                                   pattern, tuple(probe)))
    return targets


def max_sleep(cmd: str) -> float:
    seconds = {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}
    return max((float(value) * seconds[unit] for value, unit in SLEEP_RE.findall(loop_text(cmd))),
               default=0.0)


CD_RE = re.compile(r"\bcd\s+(?:'([^']*)'|\"([^\"]*)\"|([^\s;|&)]+))")
# The loop's own output files (`>> wait.log`, `| tee log`) — their changes are
# the loop's heartbeat, not progress of the awaited work.
SELF_WRITE_RE = re.compile(r"(?:\d?>>?|\btee(?:\s+-a)?)\s*$")


def resolve_path(text: str, start: int, raw: str) -> Optional[str]:
    """Absolute path for `raw` as the shell sees it at `start`, or None when
    it depends on a `cd` we can't resolve statically."""
    raw = os.path.expanduser(raw)
    if os.path.isabs(raw):
        return os.path.normpath(raw)
    base = os.getcwd()
    for c in CD_RE.finditer(text[:start]):
        d = os.path.expanduser(next(g for g in c.groups() if g is not None))
        if "$" in d or "`" in d:
            return None
        base = os.path.normpath(os.path.join(base, d))
    return os.path.normpath(os.path.join(base, raw))


def parse_path_targets(cmd: str) -> List[str]:
    text = loop_text(cmd)
    paths = []
    self_written = set()
    for m in PATH_RE.finditer(text):
        raw = next(g for g in m.groups() if g is not None)
        if SHELL_EXPANSION_RE.search(raw) or (m.group(1) is None and "$" in raw):
            continue
        path = resolve_path(text, m.start(), raw)
        if path is None:
            continue
        if SELF_WRITE_RE.search(text[:m.start()]):
            self_written.add(path)
            continue
        if path.startswith("/dev/") or path in paths or path.endswith(WATCHDOG_NAME):
            continue
        # Directories (`cd …`) and executables (`/usr/bin/…`) never signal progress.
        if os.path.isdir(path) or (os.path.isfile(path) and os.access(path, os.X_OK)):
            continue
        paths.append(path)
    return [p for p in paths if p not in self_written]


def ancestors(procs: List[Proc], pid: int) -> Set[int]:
    by_pid = {p.pid: p.ppid for p in procs}
    seen = set()
    while pid in by_pid and pid not in seen and pid > 1:
        seen.add(pid)
        pid = by_pid[pid]
    return seen


def with_descendants(procs: List[Proc], pids: List[int], pgid: int) -> List[int]:
    """`pids` plus every descendant outside our group — a `bash -c` wrapper's
    CPU is flat while the job it runs works."""
    kids = {}  # type: Dict[int, List[int]]
    for p in procs:
        if p.pgid != pgid:
            kids.setdefault(p.ppid, []).append(p.pid)
    out, stack = [], list(pids)
    seen = set()
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        out.append(pid)
        stack.extend(kids.get(pid, []))
    return out


def checker_descendant(p: Proc, by_pid: Dict[int, Proc]) -> bool:
    """A helper launched by another wait loop, rather than a real target."""
    if p.name not in HELPERS:
        return False
    parent = by_pid.get(p.ppid)
    seen = {p.pid}
    while parent is not None and parent.pid not in seen:
        kind = shell_kind(parent)
        if kind is not None:
            return kind == "inline" and is_checker_loop(parent.command)
        seen.add(parent.pid)
        parent = by_pid.get(parent.ppid)
    return False


def pgrep_matches(t: PgrepTarget, procs: List[Proc], pgid: int, exclude: Set[int]) -> Optional[List[Proc]]:
    """Use pgrep's own PID selection, including user and parent filters."""
    try:
        result = subprocess.run(
            ["/usr/bin/pgrep", *t.args], capture_output=True, text=True,
            timeout=max(POLL, 2), check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        debug_log({"stage": "pgrep-unavailable", "error": repr(e)})
        return None
    if result.returncode == 1:
        return []
    if result.returncode != 0:
        debug_log({"stage": "pgrep-failed", "returncode": result.returncode, "stderr": result.stderr})
        return None
    try:
        selected = {int(line) for line in result.stdout.splitlines()}
    except ValueError:
        debug_log({"stage": "pgrep-invalid-output", "stdout": result.stdout})
        return None
    by_pid = {p.pid: p for p in procs}
    if selected.difference(by_pid):
        # A process appeared between ps and pgrep. The snapshot cannot tell
        # whether it is real work or another waiter, so absence is unproven.
        return None
    out = []
    for p in procs:
        if p.pid not in selected or p.pgid == pgid or p.pid in exclude or is_waiter(p):
            continue
        if checker_descendant(p, by_pid):
            continue
        out.append(p)
    return out


def file_holders(path: str) -> List[int]:
    try:
        out = subprocess.run(
            ["/usr/sbin/lsof", "-t", "--", path],
            capture_output=True, text=True, timeout=max(POLL, 2),
        ).stdout
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    return [int(x) for x in out.split() if x.isdigit()]


def file_stamp(path: str) -> Optional[Tuple[int, float]]:
    try:
        st = os.stat(path)
    except OSError:
        return None
    return st.st_size, st.st_mtime


# --- diagnostics ----------------------------------------------------------------

def dump_diagnostics(pgid, busiest, reason, detail="", grace=None):
    debug_log({
        "stage": "hang-detected", "pgid": pgid, "busiest": busiest, "reason": reason,
        "idle_limit": IDLE_LIMIT, "max_runtime": MAX_RUNTIME, "detail": detail,
    })
    out = "\n\n=== command-watchdog: HANG DETECTED ({}) ===\n".format(reason)
    if reason == "orphaned":
        out += "Parent process (pid {}) exited — we've been reparented to pid {}; killing rather than waiting it out (process group {}).\n\n".format(
            PARENT_PID, os.getppid(), pgid
        )
    elif reason == "max-runtime":
        out += "Hard wall-clock cap of {}s reached regardless of activity (process group {}).\n\n".format(
            detail or MAX_RUNTIME, pgid
        )
    elif reason == "target-gone":
        out += "No awaited process matched the monitored targets for {}s while the wait-for-exit loop kept running (process group {}).\nTargets: {}\nRead its log/output file before polling again. If you poll again, prefer a PID (`kill -0 <pid>`) or a log marker over `pgrep -f`.\n\n".format(
            grace if grace is not None else TARGET_GONE_GRACE, pgid, detail
        )
    elif reason == "poll-idle":
        out += "Wait loop's targets show no progress for {}s — no matching process CPU, no file growth, no in-group work (process group {}).\nTargets: {}\nThe awaited work has stopped or stalled; read its log/output file directly rather than re-running the loop.\n\n".format(
            IDLE_LIMIT, pgid, detail
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
    if busiest and reason not in ("target-gone", "poll-idle"):
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


def child_setup() -> None:
    """Create the task's process group and require lowest priority before exec."""
    os.setpgrp()
    try:
        os.setpriority(os.PRIO_PROCESS, 0, NICE)
    except OSError as error:
        # Popen replaces preexec exceptions with a generic SubprocessError.
        # Preserve the OS diagnostic on the child's redirected stderr.
        os.write(2, (str(error) + "\n").encode("utf-8"))
        raise



# --- poll-mode activity tracker ------------------------------------------------

class PollTracker:
    """Decides, once per POLL sample, whether a wait loop's targets moved."""

    def __init__(self, cmd: str, top_pid: int, pgid: int) -> None:
        self.pgrep = parse_pgrep_targets(cmd)
        self.paths = parse_path_targets(cmd)
        self.top_pid = top_pid
        self.pgid = pgid
        self.prev_cpu = {}  # type: Dict[int, float]
        self.prev_stamp = {p: file_stamp(p) for p in self.paths}  # type: Dict[str, Optional[Tuple[int, float]]]
        self.gone_since = None  # type: Optional[float]
        self.work_present = False
        # A finished target is only noticed at the loop's next check, so the
        # grace must outlast one full `sleep N` cycle.
        self.grace = max(TARGET_GONE_GRACE, max_sleep(cmd) + 2 * POLL)

    @property
    def has_targets(self) -> bool:
        return bool(self.pgrep or self.paths)

    def describe(self) -> str:
        parts = ["{}pgrep{} {!r}".format("! " if t.negated else "", " -f" if t.full else "", t.source) for t in self.pgrep]
        parts += ["file {}".format(p) for p in self.paths]
        return "; ".join(parts) or "(none)"

    def _advanced(self, cur: Dict[int, float], pids: List[int]) -> bool:
        # A parent can stay CPU-flat while successive short-lived workers run.
        # A new worker's accrued CPU is progress even without a prior sample.
        return any(cur[pid] - self.prev_cpu.get(pid, 0.0) > CPU_EPSILON for pid in pids)

    def sample(self, now: float) -> Tuple[bool, bool]:
        """Returns (active, target_gone)."""
        procs = snapshot()
        cur = {p.pid: p.cpu for p in procs}
        exclude = ancestors(procs, os.getpid())
        active = False

        work = [
            p.pid for p in procs
            if p.pgid == self.pgid and p.pid != self.top_pid and not is_noise(p)
            and p.etime >= 2 * POLL
        ]
        self.work_present = bool(work)
        if self._advanced(cur, work):
            active = True

        negated_missing = []
        for t in self.pgrep:
            selected = pgrep_matches(t, procs, self.pgid, exclude)
            if selected is None:
                # A failed process query establishes neither progress nor absence.
                continue
            matches = [p.pid for p in selected]
            if self._advanced(cur, with_descendants(procs, matches, self.pgid)):
                active = True
            if t.wait_for_exit:
                negated_missing.append(not matches)

        other_signal = False
        for path in self.paths:
            stamp = file_stamp(path)
            if stamp is not None and stamp != self.prev_stamp.get(path):
                active = other_signal = True
            elif stamp is not None:
                holders = [
                    pid for pid in file_holders(path)
                    if pid in cur and pid not in exclude
                ]
                by_pid = {p.pid: p for p in procs}
                holders = [pid for pid in holders if by_pid[pid].pgid != self.pgid and not is_waiter(by_pid[pid])]
                if self._advanced(cur, with_descendants(procs, holders, self.pgid)):
                    active = other_signal = True
            self.prev_stamp[path] = stamp

        self.prev_cpu = cur

        gone = bool(negated_missing) and all(negated_missing) and not other_signal and not work
        if gone:
            if self.gone_since is None:
                self.gone_since = now
        else:
            self.gone_since = None
        target_gone = self.gone_since is not None and now - self.gone_since >= self.grace
        return active, target_gone


# --- main -----------------------------------------------------------------------

def kill_group(pgid: int, proc: "subprocess.Popen[bytes]") -> None:
    # Signal the whole group via a negative pid (killpg-equivalent). Ignore
    # ProcessLookupError (already gone) and PermissionError (a group member we
    # can't signal); the KILL escalation and the direct-pid fallback cover
    # stragglers.
    for sig, name in ((signal.SIGTERM, "SIGTERM"), (signal.SIGKILL, "SIGKILL")):
        for target in (-pgid, proc.pid):
            try:
                os.kill(target, sig)
            except (ProcessLookupError, PermissionError) as e:
                debug_log({"stage": "kill-signal-failed", "sig": name, "target": target, "error": type(e).__name__})
        if sig == signal.SIGTERM:
            deadline = time.time() + 3
            while time.time() < deadline and proc.poll() is None:
                time.sleep(0.1)


def main() -> int:
    cmd = " ".join(sys.argv[1:]).strip()
    if not cmd:
        print("command-watchdog: no command given", file=sys.stderr)
        return 2

    # Launch the child in its OWN process group so we can signal the whole tree
    # (e.g. a test runner + any forked browsers/vite). pgid == pid.
    r_fd, w_fd = os.pipe()
    try:
        proc = subprocess.Popen(
            ["/bin/bash", "-c", cmd], stdout=w_fd, stderr=w_fd, preexec_fn=child_setup
        )
    except (OSError, subprocess.SubprocessError) as error:
        os.close(w_fd)
        # Popen has reaped the failed child; with our writer closed, this
        # reads its setup diagnostic (or EOF) without waiting for a task.
        detail = os.read(r_fd, 65_536).decode("utf-8", errors="replace").strip() or str(error)
        os.close(r_fd)
        debug_log({"stage": "cw-launch-failed", "cmd": cmd, "error": detail})
        print("command-watchdog: unable to start command at lowest CPU priority: {}".format(detail), file=sys.stderr)
        return 125
    else:
        os.close(w_fd)
    pgid = os.getpgid(proc.pid)

    tracker = PollTracker(cmd, proc.pid, pgid) if is_poll_loop(cmd) else None
    targeted = tracker is not None and tracker.has_targets
    max_runtime = MAX_RUNTIME
    if tracker is not None and not targeted and not max_runtime:
        max_runtime = POLL_CAP
    debug_log({
        "stage": "cw-start", "cmd": cmd, "idle_limit": IDLE_LIMIT, "poll": POLL,
        "pid": proc.pid, "pgid": pgid, "nice": NICE, "poll_loop": tracker is not None,
        "targets": tracker.describe() if tracker else None, "max_runtime": max_runtime,
    })

    lock = threading.Lock()
    state = {"last_activity": time.time()}

    def reader() -> None:
        while True:
            try:
                chunk = os.read(r_fd, 65_536)
            except OSError:
                return
            if not chunk:
                return
            os.write(1, chunk)
            # A targeted wait loop's own output (`echo -n .`) is not progress
            # unless real work is running inside the group.
            if not targeted or (tracker is not None and tracker.work_present):
                with lock:
                    state["last_activity"] = time.time()

    reader_thread = threading.Thread(target=reader, daemon=True)
    reader_thread.start()

    hung = False
    last_cpu = 0.0
    last_cpu_check = time.time()
    start_time = time.time()
    target_gone = False

    while True:
        if proc.poll() is not None:
            break

        time.sleep(1)  # keep exit-latency <=1s; CPU sampling happens every POLL below
        if proc.poll() is not None:
            break
        now = time.time()

        if now - last_cpu_check >= POLL:
            last_cpu_check = now
            if targeted:
                active, target_gone = tracker.sample(now)
                if active:
                    with lock:
                        state["last_activity"] = now
            else:
                cpu, _ = group_cpu(pgid)
                if cpu - last_cpu > CPU_EPSILON:
                    last_cpu = cpu
                    with lock:
                        state["last_activity"] = now  # CPU progressed -> still alive

        with lock:
            idle = now - state["last_activity"]

        detail = ""
        if os.getppid() != PARENT_PID:
            reason = "orphaned"
        elif max_runtime and (now - start_time) >= max_runtime:
            reason = "max-runtime"
            detail = str(max_runtime)
        elif target_gone:
            reason = "target-gone"
            detail = tracker.describe() if tracker else ""
        elif idle >= IDLE_LIMIT:
            reason = "poll-idle" if targeted else "idle"
            detail = tracker.describe() if targeted else ""
        else:
            continue

        # Sampling can take long enough for the command to finish meanwhile.
        if proc.poll() is not None:
            break
        hung = True
        _, busiest = group_cpu(pgid)
        dump_diagnostics(pgid, busiest, reason, detail, tracker.grace if tracker else None)
        kill_group(pgid, proc)
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
        return 124
    exit_code = proc.returncode if proc.returncode is not None and proc.returncode >= 0 else 1
    debug_log({"stage": "cw-exit", "hung": False, "proc_returncode": proc.returncode, "exit_code": exit_code})
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
